// Copyright (C) 2022-2023, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { window } from 'vscode';
import { registerStGitConfig } from './config';
import { registerDiffMode } from './diff-mode';
import { registerDiffProvider } from './diff-provider';
import { registerStGitMode } from './stgit';

class StgitExtension {
    static instance: StgitExtension | null;
    private channel = window.createOutputChannel('stgit');

    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(this);
    }

    dispose() {
        this.channel.dispose();
        StgitExtension.instance = null;
    }

    log(line: string): void {
        this.channel.appendLine(line);
    }
}

export function log(obj: string, ...args: { toString: () => string }[]) {
    const s = [obj, ...args.map(s => s.toString())].join(' ');
    StgitExtension.instance?.log(s);
}

export function info(msg: string) {
    window.showInformationMessage(msg);
}

export function activate(context: vscode.ExtensionContext) {
    StgitExtension.instance = new StgitExtension(context);
    registerStGitConfig(context);
    registerDiffProvider(context);
    registerDiffMode(context);
    registerStGitMode(context);
    log("StGit extension activated");
}

export function deactivate() {
    // Nothing
}
