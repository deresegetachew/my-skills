# Pre-publish scan

Run this on every page file (the home page and the details page) before each publish. Fix whatever fails, then scan again.

```bash
for F in index.html details.html; do
  echo "== $F"
  # 1. Only the hosts you allow, for example the font hosts
  grep -oE 'https?://[a-zA-Z0-9.-]+' "$F" | sort -u
  # 2. Must print 0: no network calls, storage, frames, forms or inline handlers
  grep -cE 'fetch\(|XMLHttpRequest|eval\(|localStorage|sessionStorage|<iframe|<form|document\.cookie|new Function| on[a-z]+="' "$F"
  # 3. Words the owner banned (fill in the list); must print nothing
  grep -oiE '<banned words, e.g. small|cheap>' "$F"
  # 4. Required phrases and their exact counts
  grep -o '<required phrase>' "$F" | wc -l
  # 5. The page title
  grep -o '<title>[^<]*' "$F"
done
```

After the scan:
- Look at the first screens at 390 and 1440 yourself.
- Read any file you did not write before you publish it.
- Publish to the same link, with the details page as a supporting file.
- Then reply on, and resolve, each page comment you acted on.
