# agy worker

How to run agy headless, read its JSON result, and its known limits (task T3). Proven on 27 Nov: `--agent <role> --output-format json` works headless; the PreToolUse guard hook must answer `{"decision":"allow"}` to allow (an empty `{}` refuses); deny rules match by prefix such as `command(git push)`, and regex rules did not match.
