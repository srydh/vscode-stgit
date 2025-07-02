// Copyright (C) 2022-2023, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { run } from "./util";

export class RepositoryInfo {
    private static repoCache =
        new Map<string, Promise<RepositoryInfo | null>>();

    private constructor(
        public readonly gitDir: string,
        public readonly topLevelDir: string,
    ) { }

    getPathUri(path: string): vscode.Uri {
        return vscode.Uri.joinPath(vscode.Uri.file(this.topLevelDir), path);
    }

    private static async findTopLevelDir(path: string) {
        return await run('git', ['rev-parse', '--show-toplevel'], {
            cwd: path,
        });
    }

    private static async findGitDir(path: string) {
        return await run('git', ['rev-parse', '--absolute-git-dir'], {
            cwd: path,
        });
    }

    private static async create(ws: string) {
        const [topDir, gitDir] = await Promise.all([
            this.findTopLevelDir(ws),
            this.findGitDir(ws),
        ]);
        if (topDir && gitDir)
            return new RepositoryInfo(gitDir, topDir);
        return null;
    }

    private static getActiveWorkspaceFolder():
        vscode.WorkspaceFolder | undefined {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return workspace.workspaceFolders?.[0];
        }

        return workspace.getWorkspaceFolder(activeEditor.document.uri);
    }

    static async lookup(): Promise<RepositoryInfo | null> {
        const ws_path = this.getActiveWorkspaceFolder()?.uri.path;

        if (!ws_path) {
            return null;
        }

        if (!this.repoCache.has(ws_path)) {
            this.repoCache.set(ws_path, this.create(ws_path));
        }

        return this.repoCache.get(ws_path)!;
    }
}
