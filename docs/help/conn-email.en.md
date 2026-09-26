# Connect a mailbox (any email via IMAP / SMTP)

How to connect any mailbox with an app password, so roles can read and send email.

## Any mailbox (IMAP / SMTP)

The easiest route: no approval from any platform. Type your email address and we recognize the provider and fill in the server addresses; all you do is create an "app password" in your mailbox.

**How**

1. Sign in to your webmail and find "Settings → Accounts" or "Account security".
2. Turn on IMAP / SMTP. Many providers keep it off by default.
3. Generate an app password (some call it an authorization code or a client-specific password).
4. Enter your email address and that password in the form; the server addresses fill themselves in.
5. Click "Save and test": it only counts as connected once both the inbox login and the sending handshake pass.

**Where each provider keeps its app password**

- [QQ Mail authorization code](https://service.mail.qq.com/detail/0/75)
- [163 Mail authorization code](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b)
- [Gmail app passwords](https://support.google.com/accounts/answer/185833)

## FAQ

- **I used my normal login password and the test fails**: this needs the app password, not your login password. Create one as in step 3.
- **The test doesn't pass**: both the inbox login and the sending handshake must succeed. First check that IMAP / SMTP is really switched on in your mailbox.
- **Should I use the Google sign-in route for Gmail?** If you only need to read and answer support email, this one is enough and far simpler. The Google route means building your own OAuth app — see [The Google connections](help:conn-google).
