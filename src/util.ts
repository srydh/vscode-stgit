// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as os from 'os';
import * as fs from 'fs';
import * as fs_prom from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { log, info } from './extension';
import { RepositoryInfo } from './repo';
import { getStGitConfig } from './config';
import { hasStGit2 } from './git';

type Command = "stg" | "git";

interface RunOpts {
    trim?: boolean,
    env?: {[key: string]: string},
    cwd?: string,
    stdin?: string,
}

interface CommandResult {
    stdout: string,
    stderr: string,
    ecode: number,
}

/**
 * Run a process to completion while capturing stdout and stdin.
 * @param command the command to run
 * @param args command arguments
 * @param opts spawn and output trim options
 * @returns process output and error code (-1 if the spawn failed)
 */
export async function runCommand(
    command: Command, args: string[], opts?: RunOpts
): Promise<CommandResult> {
    let cmd: string;
    const config = getStGitConfig();
    if (command === 'git')
        cmd = config.gitExecutable;
    else if (command === 'stg')
        cmd = config.stgitExecutable;
    else
        throw new Error("Unexpected command");

    const cwd = opts?.cwd ?? (await RepositoryInfo.lookup())?.topLevelDir;
    if (!cwd)
        return {stdout: "", stderr: "", ecode: -1};
    const env = opts?.env ? {...process.env, ...opts.env} : undefined;
    const stdinPipe = opts?.stdin ? 'pipe' : 'ignore';
    const proc = spawn(cmd, args, {
        cwd: cwd,
        env: env,
        stdio: [stdinPipe, 'pipe', 'pipe']
    });
    if (opts?.stdin) {
        proc.stdin!.write(opts.stdin);
        proc.stdin!.end();
    }
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
export async function run(
        command: Command, args: string[], opts?: RunOpts
): Promise<string> {
    return (await runCommand(command, args, opts)).stdout;
}

export async function runAndReportErrors(
    command: Command, args: string[], opts?: RunOpts
): Promise<CommandResult> {
    const result = await runCommand(command, args, opts);
    if (result.ecode !== 0) {
        if (await hasStGit2()) {
            info(result.stderr);
        } else {
            // StGit 1.x uses stderr for all output; extract the actual error
            const m = result.stderr.split("\n").filter(
                s => s.includes(':')).join("\n");
            info(m || result.stderr);
        }
    }
    return result;
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

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
