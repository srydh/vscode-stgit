// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, commands, window } from 'vscode';
import { info } from './extension';
import { run, runCommand } from './util';

class DiffProvider {
    static instance: DiffProvider | null = null;
    readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

    constructor(context: vscode.ExtensionContext) {
        const diffProvider: vscode.TextDocumentContentProvider = {
            onDidChange: this.changeEmitter.event,
            provideTextDocumentContent: (uri, token) => {
                return DiffProvider.instance?.provideDiff(uri) ?? "";
            }
        };
        const blobProvider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri, token) => {
                return DiffProvider.instance?.provideTextBlob(uri) ?? "";
            }
        };
        function cmd(cmd: string, func: () => void) {
            return commands.registerTextEditorCommand(`sdiff.${cmd}`, func);
        }
        context.subscriptions.push(
            this,
            workspace.registerTextDocumentContentProvider(
                'stgit-diff', diffProvider),
            workspace.registerTextDocumentContentProvider(
                'stgit-blob', blobProvider),

            cmd('openCurrentFileDiff', () => this.openCurrentFileDiff()),
        );
    }
    dispose() {
        this.changeEmitter.dispose();
        DiffProvider.instance = null;
    }
    async openCurrentFileDiff() {
        const editor = window.activeTextEditor;
        if (!editor)
            return;
        const path = workspace.asRelativePath(editor.document.uri);
        const uri = vscode.Uri.parse(`stgit-diff:///diff-${path}#file=${path}`);
        refreshDiff(uri);
        const result = await runCommand('git', ['diff', '--quiet', '--', path]);
        if (!result.ecode) {
            const r2 = await runCommand(
                'git', ['ls-files', '--error-unmatch', '--', path]);
            if (r2.ecode)
                info(`'${path}' is not under version control`);
            else
                info(`'${path}' is unmodified`);
        } else {
            const doc = await workspace.openTextDocument(uri);
            vscode.languages.setTextDocumentLanguage(doc, 'diff');
            window.showTextDocument(doc, {preview: true});
        }
    }

    provideTextBlob(uri: vscode.Uri): Promise<string> {
        const sha = uri.fragment;
        return run('git', ['show', sha], {trim: false});
    }
    async provideDiff(uri: vscode.Uri): Promise<string> {
        const args = uri.fragment.split(',').map(
            s => (s + "=").split("=", 2) as [string, string]);
        const d = new Map(args);
        const diffArgs: string[] = [];
        const index = d.has('index');
        const sha = d.get('sha');
        const file = d.get('file');
        const noTrim = {trim: false};
        let header: Promise<string> | null = null;
        if (index)
            diffArgs.push('--cached');
        else if (sha)
            diffArgs.push(`${sha}^`, sha);
        if (sha && !file)
            header = run('git', ['show', '--stat', sha], noTrim);
        if (file)
            diffArgs.push('--', file);
        const diff = run('git', ['diff', ...diffArgs], noTrim);
        if (header)
            return [await header, await diff].join("\n");
        return diff;
    }
}

export function refreshDiff(uri: vscode.Uri) {
    DiffProvider.instance?.changeEmitter.fire(uri);
}

export function registerDiffProvider(context: vscode.ExtensionContext) {
    DiffProvider.instance = new DiffProvider(context);
}
