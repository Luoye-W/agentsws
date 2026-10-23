---
description: Assistant, at the top of the sidebar, chats, checks what every position is doing and hands tasks to the right one. It never changes anything external on its own.
---
# Assistant: chat, or hand things off

"Assistant" at the top of the sidebar works like the chat box on ChatGPT or Claude. The old "Chat" and "My agent" are now this one entry.

## What it does

- **Chat**: ask anything, draft some text, translate, brainstorm. Turn on "Web search" for fresh public information, or "Use company knowledge" to answer only from your knowledge base, with sources. You can paste images too.
- **See everything at a glance**: "What is each position doing today?", "What needs me today?", "What did we send recently?", "Where is that return email from last week?" — it looks first, then answers from what it found. Read-only: it changes nothing.
- **Hand off a task**: say it the way you would to a position; the assistant passes it on (see below).

## Handing off a task

1. Say it the way you would to a position, e.g. "Have Reddit Ops check today's new posts".
2. The assistant picks the position (and the duty in it) and opens a task there; "Handed to Reddit Ops · Official Subreddit" shows under its reply — click it to open the task.
3. When the task finishes, or needs your decision, the assistant says so in the same chat, with "Open" or "Decide" right next to it.

## What it won't do

- The assistant **never changes anything outside by itself**. Posting, replying, changing prices or the store are handed to a position; anything external still comes to you as a card to approve.
- **When it isn't sure who should do it, it asks** instead of guessing, listing the positions to choose from.

## One conversation, all the way down

The assistant keeps a single conversation — no new chats to start, no list to dig through. Scroll up for everything you've said before: a date marks each new day, and a faint line marks each new topic, with a one-line summary of the topic before it (hover for the full summary).

- **Switch topics**: click "New topic" at the top right, or just say "new topic, …". After a two-hour break, the next day, or when you clearly move on to something else, the assistant starts a new topic by itself.
- **Find something you said**: click the magnifier at the top left, type a couple of words, and click a result to jump there.
- **What it keeps in mind**: each reply only reads the current topic word for word, short summaries of the last few topics, and your "Memory" — so a long conversation doesn't get slower or pricier. When you mention something older ("last week's meeting notes"), it looks it up itself and shows "Source" chips under the reply that jump to the original line. Progress on handed-off work is always checked live, never recalled from the chat.

## One document, several positions

After a meeting, the follow-ups usually belong to several positions, and several positions need to remember new rules. You don't have to tell each one:

1. Attach the notes (paperclip at the bottom right of the input: .txt / .md / .docx / .pdf / .xlsx / .csv; pasting a long block of text works too — it becomes an attachment) and say "split this up".
2. The assistant shows "Here's how I'd split it", grouped by position: **to do** items (with due dates and the original line) and **to remember** rules; brand-wide rules get their own group, and your personal habits stay with the assistant.
3. Click "Looks good" if it's right. "Adjust" lets you untick, reassign or reword any item. Items with an unclear owner are only sent once you pick someone.
4. A summary follows: how many tasks each position got (click to open) and how many notes. Each task reports back to this conversation, grouped by batch.

New rules take effect the moment you click "Looks good": they go into each position's knowledge base with the original line attached, no second confirmation. If something is wrong, "Undo these N notes" on the summary card withdraws the whole batch, and each note can be edited or removed in the knowledge base or at the top of a position's Knowledge panel ("noted by the assistant"). Spreadsheets (.xlsx / .csv) are read row by row; very long ones are cut at a whole row and the assistant says so. The input boxes on position pages and inside each task take attachments the same way (drag them in or use "+"), and the position works with them. Files with no readable text (scans, encrypted PDFs) are reported as such; anything that looks like a password or key is removed before the AI sees it and never goes into the knowledge base.

## Name someone directly

Type `@` in the box and pick a position (or a duty inside it). The message goes straight to it.

## Suggested questions

Under the box you'll see a few questions based on where you are: "What needs me today?" when cards are waiting, "What did <position> do today?" and a sample hand-off when you have positions, or "Help me set up a position" when you have none yet. They fold away once you start chatting.

## Memory

Say "remember: …", or "from now on …", and it will keep it in mind (a small "Noted" appears top-right). "Memory" at the top right lists everything it remembers; delete what you don't want, and it won't add it back on its own. With "Auto memory" off in settings, it only remembers when you say "remember".

## Answer colleagues for me

When you work with colleagues (peers or company mode), the top right also has "Answer colleagues for me": who asked you what and what it answered, meeting requests, what you share with colleagues (positions, strengths, when you're free), and asking a colleague's assistant. It isn't shown when you use Agents Workshop on your own.
