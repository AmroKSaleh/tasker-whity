# {mcp} Drive: native Google Docs/Sheets via convert-on-import (TDE-312)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**TDE-312 — drive_upload_file can now create editable native Google Docs/Sheets.**

## The bug it fixed
`drive_upload_file` put `args.mime_type` straight into the multipart *content* part's `Content-Type`, and the file metadata had NO `mimeType`. Passing `application/vnd.google-apps.document` as mime_type → Drive rejects with "Invalid MIME type provided for the uploaded content". You can't ask Drive to create a Doc by declaring the upload content to be a Doc.

## The fix (convert-on-import)
Two MIME types are involved and must be kept separate:
- **metadata `mimeType`** = the google-apps target type Drive STORES it as (`application/vnd.google-apps.document` / `.spreadsheet`). Setting this is what triggers conversion.
- **content part `Content-Type`** = the SOURCE format Drive converts FROM (text/html or text/markdown → Doc; text/csv → Sheet).

New `target_type` param: `file` (default, unchanged raw upload) | `doc` | `sheet`. `mime_type` now means the source content type. Defaults: doc→text/html, sheet→text/csv, file→text/plain.

## Gotcha: reading native files back
Native google-apps files CANNOT be downloaded with `?alt=media` (returns "Use Export with the Docs Editors API"). `drive_read_file` now fetches `?fields=mimeType` first, and for google-apps types hits `/export?mimeType=...` instead (Docs→text/markdown, Sheets→text/csv). Plain files still use alt=media. Any new Drive-read code must branch on mimeType the same way.

## Follow-ups — DONE (2026-06-25)
- **store_artifact** got the same capability: new `drive_target_type` (file/doc/sheet) param on its `upload_to_drive` path, reusing the convert-on-import split.
- **Delete files from the task card UI** (TaskDetailPanel `DriveAttachments`): each Drive file row has an × button → confirm popup with two modes:
  - *link* = remove the file from `task.output.drive_files` only (Drive untouched)
  - *drive* = also DELETE the file from Google Drive (treats 404 as success).
  Implemented as a new `delete` action in the **drive-files** edge function (browser can't hold the Google token), client helper `deleteDriveFile(taskId, fileId, mode)` in lib/driveFiles.js. Note: drive-files is the BROWSER-callable Drive function (JWT auth); the MCP tools are the AI-callable twins — Drive logic now lives in BOTH, keep in sync like the contract-gate.

## Verified
Created a Doc on TDE-276 from HTML, opened+edited it in Drive, read it back via export — got the live edited content. Delete popup verified working on live by user.
