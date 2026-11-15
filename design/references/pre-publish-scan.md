# Pre-publish scan

Run these on each page file (the home page, then the details page) before each publish. Put the file's name where it says `<page>.html`. Fix whatever fails, then scan again.

```bash
# 1. Only the hosts you allow, for example the font hosts
grep -oE 'https?://[a-zA-Z0-9.-]+' <page>.html | sort -u
# 2. Must print 0: no network calls, storage, frames, forms or inline handlers
grep -cE 'fetch\(|XMLHttpRequest|eval\(|localStorage|sessionStorage|<iframe|<form|document\.cookie|new Function| on[a-z]+="' <page>.html
# 3. Words the owner banned (fill in the list); must print nothing
grep -oiE '<banned word>|<another banned word>' <page>.html
# 4. Required phrases and their exact counts
grep -o '<required phrase>' <page>.html | wc -l
# 5. The page title
grep -o '<title>[^<]*' <page>.html
```

After the scan:
- Look at the first screens at 390 and 1440 yourself.
- Read any file you did not write before you publish it.
- Publish to the same link, with the details page as a supporting file.
- Then reply on, and resolve, each page comment you acted on.
