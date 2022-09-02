# StGit VSCode Support

The StGit extension adds StGit support to VSCode. StGit is an external tool
whih manages patch series in the form of Git commits. The tools allows
individual changes to be modified, amended, reordered, split etc. with ease.
Refer to the [StGit homepage](https://stacked-git.github.io/) for more details.

## Features

This extension is heavily inspired from the corresponding Emacs mode for StGit. A text buffer displays patches and changes, and a multitute of operations are bound to various keys.

![StGit](images/example.png)

> Hint: To enster StGit, press `Ctrl-C Ctrl-I` or run the "`StGit: Open...`"
command. In the `stgit` buffer, press `h` to list all available StGit
operations.

## Requirements

This extension requires StGit to be install (the executable is called `stg`). The tool is available in most distributions, e.g. "`brew install stgit`" on macOS). It can also be downloaded from GitHub [here](https://stacked-git.github.io).

<!--
## Extension Settings

This extension contributes the following settings:

* `myExtension.enable`: enable/disable this extension
* `myExtension.thing`: set to `blah` to do something
-->

## Known Issues

The tool is currently configured for "hardcore" users. I.e. no warnings
before deleting patches etc (StGit comes with functionality to undo most
operations though).

## Release Notes

### 0.9.0

Initial release of the StGit extension.
