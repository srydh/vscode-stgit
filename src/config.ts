// Copyright (C) 2022-2023, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { log } from './extension';
import { getStGitVersion } from './git';

class StGitConfig {
    static instance: StGitConfig | null = null;

    gitExecutable = "git";
    stgitExecutable = "stg";
    showUnknownFiles = false;

    private readonly configChanged = new vscode.EventEmitter<void>();

    private constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            this,
            workspace.onDidChangeConfiguration((ev) => {
                if (ev.affectsConfiguration('stgit'))
                    this.configChanged.fire();
            }),
        );
        this.onDidChangeConfiguration(() => this.fetchConfig());
        this.fetchConfig();
    }
    static create(context: vscode.ExtensionContext) {
        this.instance = new this(context);
        this.instance.trackStGitVersion();
    }

    dispose() {
        this.configChanged.dispose();
        StGitConfig.instance = null;
    }

    private fetchConfig() {
        const config = workspace.getConfiguration('stgit');
        this.gitExecutable = config.get('gitExecutable') ?? "git";
        this.stgitExecutable = config.get('stgitExecutable') ?? "stg";
        this.showUnknownFiles = config.get('showUnknownFiles', false);
    }

    private trackStGitVersion() {
        let stgExecutable: string | null = null;

        const reportStGitVersion = async () => {
            if (this.stgitExecutable !== stgExecutable) {
                stgExecutable = this.stgitExecutable;
                const version = await getStGitVersion({ forceRefresh: true });
                log(`StGit version: ${version}`);
            }
        };
        this.onDidChangeConfiguration(reportStGitVersion);
        reportStGitVersion();
    }

    onDidChangeConfiguration(callback: () => void): vscode.Disposable {
        return this.configChanged.event(callback);
    }
}

export function getStGitConfig(): StGitConfig {
    if (!StGitConfig.instance)
        throw new Error("config error: StGit extension not loaded");
    return StGitConfig.instance;
}

export function registerStGitConfig(context: vscode.ExtensionContext): void {
    StGitConfig.create(context);
}
