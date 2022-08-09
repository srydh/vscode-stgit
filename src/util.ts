// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as os from 'os';
import * as fs from 'fs';
import * as fs_prom from 'fs/promises';
import * as path from 'path';
import { workspace } from 'vscode';
import { spawn } from 'child_process';
import { log } from './extension';

interface RunOpts {
    trim?: boolean,
    env?: {[key: string]: string},
    cwd?: string,
}

/**
 * Run a process to completion while capturing stdout and stdin.
 * @param command the command to run
 * @param args command arguments
 * @param opts spawn and output trim options
 * @returns process output and error code (-1 if the spawn failed)
 */
export async function runCommand(
    command: string, args: string[], opts?: RunOpts
): Promise<{stdout: string, stderr: string, ecode: number}> {
    const cwd = opts?.cwd ?? workspace.workspaceFolders?.[0].uri.path;
    if (!cwd)
        return {stdout: "", stderr: "", ecode: -1};
    const env = opts?.env ? {...process.env, ...opts.env} : undefined;
    const proc = spawn(command, args, {cwd, env});

    const data: string[] = [];
    const errorData: string[] = [];
    proc.stdout!.on('data', (s) => { data.push(s); });
    proc.stderr!.on('data', (s) => { errorData.push(s); });

    let exitCode = -1;
    await new Promise<void>((resolve, _) => {
        proc.on('close', (code) => { exitCode = code ?? 1; resolve(); });
        proc.on('error', (err) => { exitCode = -1 ; resolve(); });
    });
    if (exitCode !== 0)
        log(['[failed]', command, ...args].join(' '));
    const stdout = data.join('');
    return {
        stdout: opts?.trim !== false ? stdout.trimEnd() : stdout,
        stderr: errorData.join('').trimEnd(),
        ecode: exitCode,
    };
}

/**
 * Simplified version of {@link runCommand} which just returns the captured
 * output.
 * @returns captured output or an empty string if process spawn failed
 */
export async function run(command: string, args: string[], opts?: RunOpts) {
    return (await runCommand(command, args, opts)).stdout;
}

/**
 * Create a temporary directory and run calllback. The
 * directory, and its contents, is removed when the callback is finished.
 * @param callback callback to run
 * @returns promise which resolves to the callback return value
 */
export async function withTempDir<X>(
    callback: (tmpdir: string) => X | Promise<X>
): Promise<X> {
    const tempDir = await fs_prom.mkdtemp(path.join(os.tmpdir(), "stgit-tmp"));
    try {
        return await callback(tempDir);
    } finally {
        fs.rm(tempDir, {recursive: true, force: true}, (err) => {/**/});
    }
}
