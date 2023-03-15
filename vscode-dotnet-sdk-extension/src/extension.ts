/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as cp from 'child_process';
import * as fs from 'fs';
import open = require('open');
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    AcquireErrorConfiguration,
    AcquisitionInvoker,
    callWithErrorHandling,
    DotnetAcquisitionRequested,
    DotnetAcquisitionStatusRequested,
    DotnetCoreAcquisitionWorker,
    DotnetSDKAcquisitionStarted,
    enableExtensionTelemetry,
    ErrorConfiguration,
    ExtensionConfigurationWorker,
    formatIssueUrl,
    IDotnetAcquireContext,
    IDotnetListVersionsContext,
    IDotnetListVersionsResult,
    IDotnetVersion,
    DotnetVersionSupportStatus,
    IDotnetUninstallContext,
    IEventStreamContext,
    IExtensionContext,
    IIssueContext,
    InstallationValidator,
    registerEventStream,
    SdkInstallationDirectoryProvider,
    VersionResolver,
    WindowDisplayWorker,
} from 'vscode-dotnet-runtime-library';
import { IWindowDisplayWorker } from 'vscode-dotnet-runtime-library/dist/EventStream/IWindowDisplayWorker';
import { dotnetCoreAcquisitionExtensionId } from './DotnetCoreAcquistionId';
import { WebRequestWorker } from 'vscode-dotnet-runtime-library/src/Utils/WebRequestWorker';
// tslint:disable no-var-requires
const packageJson = require('../package.json');

// Extension constants
namespace configKeys {
    export const installTimeoutValue = 'installTimeoutValue';
    export const enableTelemetry = 'enableTelemetry';
}
namespace commandKeys {
    export const acquire = 'acquire';
    export const acquireStatus = 'acquireStatus';
    export const listSdks = 'listSdks'
    export const uninstallAll = 'uninstallAll';
    export const showAcquisitionLog = 'showAcquisitionLog';
    export const reportIssue = 'reportIssue';
}
const commandPrefix = 'dotnet-sdk';
const configPrefix = 'dotnetSDKAcquisitionExtension';
const displayChannelName = '.NET SDK';
const defaultTimeoutValue = 300;
const pathTroubleshootingOption = 'Troubleshoot';
const troubleshootingUrl = 'https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/troubleshooting-sdk.md';
const availableDontetVersionsUrl = 'https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json';
const knownExtensionIds = ['ms-dotnettools.sample-extension', 'ms-dotnettools.vscode-dotnet-pack'];

export function activate(context: vscode.ExtensionContext, extensionContext?: IExtensionContext) {
    const extensionConfiguration = extensionContext !== undefined && extensionContext.extensionConfiguration ?
        extensionContext.extensionConfiguration :
        vscode.workspace.getConfiguration(configPrefix);

    const eventStreamContext = {
        displayChannelName,
        logPath: context.logPath,
        extensionId: dotnetCoreAcquisitionExtensionId,
        enableTelemetry: enableExtensionTelemetry(extensionConfiguration, configKeys.enableTelemetry),
        telemetryReporter: extensionContext ? extensionContext.telemetryReporter : undefined,
        showLogCommand: `${commandPrefix}.${commandKeys.showAcquisitionLog}`,
        packageJson,
    } as IEventStreamContext;
    const [eventStream, outputChannel, loggingObserver, eventStreamObservers] = registerEventStream(eventStreamContext);

    const displayWorker = extensionContext ? extensionContext.displayWorker : new WindowDisplayWorker();
    const extensionConfigWorker = new ExtensionConfigurationWorker(extensionConfiguration, undefined);
    const issueContext = (errorConfiguration: ErrorConfiguration | undefined, commandName: string, version?: string) => {
        return {
            logger: loggingObserver,
            errorConfiguration: errorConfiguration || AcquireErrorConfiguration.DisplayAllErrorPopups,
            displayWorker,
            extensionConfigWorker,
            eventStream,
            commandName,
            version,
            timeoutInfoUrl: `${troubleshootingUrl}#install-script-timeouts`,
            moreInfoUrl: troubleshootingUrl,
        } as IIssueContext;
    };

    const timeoutValue = extensionConfiguration.get<number>(configKeys.installTimeoutValue);
    let storagePath: string;
    if (os.platform() === 'win32') {
        // Install to %AppData% on windows to avoid running into long path errors
        storagePath = process.env.APPDATA ? process.env.APPDATA : context.globalStoragePath;
    } else {
        storagePath = path.join(os.homedir(), '.vscode-dotnet-sdk');
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath);
        }
    }

    const acquisitionWorker = new DotnetCoreAcquisitionWorker({
        storagePath,
        extensionState: context.globalState,
        eventStream,
        acquisitionInvoker: new AcquisitionInvoker(context.globalState, eventStream),
        installationValidator: new InstallationValidator(eventStream),
        timeoutValue: timeoutValue === undefined ? defaultTimeoutValue : timeoutValue,
        installDirectoryProvider: new SdkInstallationDirectoryProvider(storagePath),
    });

    const versionResolver = new VersionResolver(context.globalState, eventStream);

    const dotnetAcquireRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.acquire}`, async (commandContext: IDotnetAcquireContext) => {
        if (commandContext.requestingExtensionId === undefined) {
            return Promise.reject('No requesting extension id was provided.');
        } else if (!knownExtensionIds.includes(commandContext.requestingExtensionId!)) {
            return Promise.reject(`${commandContext.requestingExtensionId} is not a known requesting extension id. The vscode-dotnet-sdk extension can only be used by ms-dotnettools.vscode-dotnet-pack.`);
        }

        const pathResult = callWithErrorHandling(async () => {
            eventStream.post(new DotnetSDKAcquisitionStarted());

            eventStream.post(new DotnetAcquisitionRequested(commandContext.version, commandContext.requestingExtensionId));
            const resolvedVersion = await versionResolver.getFullSDKVersion(commandContext.version);
            const dotnetPath = await acquisitionWorker.acquireSDK(resolvedVersion);
            const pathEnvVar = path.dirname(dotnetPath.dotnetPath);
            setPathEnvVar(pathEnvVar, displayWorker, context.environmentVariableCollection);
            return dotnetPath;
        }, issueContext(commandContext.errorConfiguration, 'acquireSDK'));
        return pathResult;
    });

    const dotnetAcquireStatusRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.acquireStatus}`, async (commandContext: IDotnetAcquireContext) => {
        const pathResult = callWithErrorHandling(async () => {
            eventStream.post(new DotnetAcquisitionStatusRequested(commandContext.version, commandContext.requestingExtensionId));
            const resolvedVersion = await versionResolver.getFullSDKVersion(commandContext.version);
            const dotnetPath = await acquisitionWorker.acquireStatus(resolvedVersion, false);
            return dotnetPath;
        }, issueContext(commandContext.errorConfiguration, 'acquireSDKStatus'));
        return pathResult;
    });
    
    /**
     * @remarks 
     * Use the release.json manifest which contains the newest version of the SDK and Runtime for each major.minor of .NET to get the available versions.
     * Relies on the context listRuntimes to tell if it should get runtime or sdk versions.
     * 
     * @returns
     * IDotnetListVersionsResult of versions available.
     * 
     * @throws
     * Exception if the API service for releases-index.json is unavailable.
     */
    const dotnetListSdksRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.listSdks}`, async (commandContext: IDotnetListVersionsContext | undefined, customWebWorker: WebRequestWorker | undefined) => {
        let getSdks : boolean = commandContext?.listRuntimes === null || commandContext?.listRuntimes === undefined || !commandContext.listRuntimes; // If false, getRuntimes, else, get Sdks.

        // Acquire the SDK Versions Available.
        let webWorker = customWebWorker != undefined ? customWebWorker : new WebRequestWorker(
            context.globalState,
            eventStream,
            availableDontetVersionsUrl,
            'listSDKVersionsCacheKey'
        );

        var availableVersions : IDotnetListVersionsResult = [];

        let response = await webWorker.getCachedData();
        
        if (!response) {
            throw new Error('The service to request available SDK versions (releases.json) is unavailable.');
        }
        else
        {
            let SdkDetailsJson = JSON.parse(response)['releases-index'];

            for(let availableSdk of SdkDetailsJson)
            {
                if(availableSdk['release-type'] === 'lts' || availableSdk['release-type'] === 'sts')
                {
                    availableVersions.push({supportStatus: (availableSdk['release-type'] as DotnetVersionSupportStatus), version: availableSdk[getSdks ? 'latest-sdk' : 'latest-runtime']} as IDotnetVersion);
                }
            }
        }
            
        return availableVersions;
    });

    const dotnetUninstallAllRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.uninstallAll}`, async (commandContext: IDotnetUninstallContext | undefined) => {
        await callWithErrorHandling(async () => {
            await acquisitionWorker.uninstallAll();
        }, issueContext(commandContext ? commandContext.errorConfiguration : undefined, 'uninstallAll'));
    });

    const showOutputChannelRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.showAcquisitionLog}`, () => outputChannel.show(/* preserveFocus */ false));

    const reportIssueRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.reportIssue}`, async () => {
        const [url, issueBody] = formatIssueUrl(undefined, issueContext(AcquireErrorConfiguration.DisableErrorPopups, 'reportIssue'));
        await vscode.env.clipboard.writeText(issueBody);
        open(url);
    });

    context.subscriptions.push(
        dotnetAcquireRegistration,
        dotnetAcquireStatusRegistration,
        dotnetListSdksRegistration,
        dotnetUninstallAllRegistration,
        showOutputChannelRegistration,
        reportIssueRegistration,
        ...eventStreamObservers);
}

function setPathEnvVar(pathAddition: string, displayWorker: IWindowDisplayWorker, environmentVariables: vscode.EnvironmentVariableCollection) {
    // Set user PATH variable
    let pathCommand: string | undefined;
    if (os.platform() === 'win32') {
        pathCommand = getWindowsPathCommand(pathAddition);
    } else {
        pathCommand = getLinuxPathCommand(pathAddition);
    }

    if (pathCommand !== undefined) {
        runPathCommand(pathCommand, displayWorker);
    }

    // Set PATH for VSCode terminal instances
    if (!process.env.PATH!.includes(pathAddition)) {
        environmentVariables.append('PATH', path.delimiter + pathAddition);
        process.env.PATH += path.delimiter + pathAddition;
    }
}

function getLinuxPathCommand(pathAddition: string): string | undefined {
    const profileFile = os.platform() === 'darwin' ? path.join(os.homedir(), '.zshrc') : path.join(os.homedir(), '.profile');
    if (fs.existsSync(profileFile) && fs.readFileSync(profileFile).toString().includes(pathAddition)) {
        // No need to add to PATH again
        return undefined;
    }
    return `echo 'export PATH="${pathAddition}:$PATH"' >> ${profileFile}`;
}

function getWindowsPathCommand(pathAddition: string): string | undefined {
    if (process.env.PATH && process.env.PATH.includes(pathAddition)) {
        // No need to add to PATH again
        return undefined;
    }
    return `for /F "skip=2 tokens=1,2*" %A in ('%SystemRoot%\\System32\\reg.exe query "HKCU\\Environment" /v "Path" 2^>nul') do ` +
        `(%SystemRoot%\\System32\\reg.exe ADD "HKCU\\Environment" /v Path /t REG_SZ /f /d "${pathAddition};%C")`;
}

function runPathCommand(pathCommand: string, displayWorker: IWindowDisplayWorker) {
    try {
        cp.execSync(pathCommand);
    } catch (error) {
        displayWorker.showWarningMessage(`Unable to add SDK to the PATH: ${error}`,
            async (response: string | undefined) => {
                if (response === pathTroubleshootingOption) {
                    open(`${troubleshootingUrl}#unable-to-add-to-path`);
                }
            }, pathTroubleshootingOption);
    }
}
