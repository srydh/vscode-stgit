// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import { log } from "./extension";
import { run } from "./util";

export async function updateIndex(
    path: string,
    contents: {data?: string, mode?: string}
) {
    let mode: string | undefined;
    let sha: string | undefined;

    if (contents.data === undefined || contents.mode === undefined) {
        const tree = await run('git', ['write-tree']);
        const info = await run('git', ['ls-tree', tree, '--', path]);
        const re = /([0-9]*) [a-z]* ([a-fA-F0-9]*)/;
        [, mode, sha] = info.match(re) ?? [];
    }
    if (!mode)
        mode = "100644";
    if (contents.data) {
        sha = await run('git', ['hash-object', '-w', '--stdin'], {
            stdin: contents.data ?? ""
        });
    }
    if (!sha) {
        log("updateIndex: !sha");
        return;
    }
    const cacheInfo = [mode, sha, path].join(",");
    await run('git', ['update-index', '--cacheinfo', cacheInfo]);
}
