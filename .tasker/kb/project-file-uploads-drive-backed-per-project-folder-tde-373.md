# Project file uploads — Drive-backed, per-project folder (TDE-373)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Shipped 2026-07-06. Lets you save whole documents/files to a PROJECT (the gap: previously only task-scoped store_artifact existed). Decision (user): back it entirely with Google Drive, NOT native Supabase storage — deliberately dodges the "Supabase costs at scale" Foundation risk. A button opens the project's Drive folder.

**Key discovery:** the `drive-files` edge function ALREADY did binary multipart upload + the Tasker→Project→sub folder hierarchy (built for task attachments). So this was mostly extension, not new infra.

**Conversion rule (CORRECTED — see bug below):** only WORD-PROCESSOR formats convert to an editable Google Doc via convert-on-import — `DOC_EXTS = ['doc','docx','odt','rtf']`. Text, Markdown, and especially HTML upload AS-IS. Rationale: you convert a Word file because you otherwise can't easily view/edit it; text/md/html are already viewable, and converting HTML to a Doc DESTROYS its styling/layout.
⚠️ BUG CAUGHT + FIXED same day: the first cut also had html/htm/txt/md in DOC_EXTS, so an uploaded styled HTML report got flattened into a mangled Google Doc. Do NOT put html/txt/md back in the conversion set.

**What was added to drive-files/index.ts:**
- `resolveProjectFolder(authClient, ...)` — ensures/persists a project's Drive folder (projects.google_drive_folder_id, column already existed). IMPORTANT: uses the RLS-respecting AUTH client for the project row, not the service-role client, so a user can't upload into a project they can't access (service role would bypass that). Returns folder id + webViewLink.
- JSON actions: `project_folder` (folder id + link), `project_list` (files in the folder, live from Drive), `project_delete` (real Drive delete).
- Upload: accepts `project_id` form field (vs task_id) → uploads to the project folder root, no flow subfolder, no PREFIX-SHORTID filename injection. DOC_EXTS → metadata.mimeType=google-apps.document (convert-on-import); others upload raw. Requests fields=id,name,mimeType,webViewLink.
- Deployed with DEFAULT jwt verification (NOT --no-verify-jwt) — like the other browser-called Google functions (google-connect etc.); the browser sends the Supabase session token which the gateway + authClient.getUser() validate. Only the MCP function uses --no-verify-jwt.

**Web:** lib/driveFiles.js gains uploadFileToProjectDrive / listProjectDriveFiles / getProjectDriveFolder / deleteProjectDriveFile (throw 'DRIVE_NOT_CONNECTED' on the 400 so the UI shows a connect prompt). components/board/ProjectFilesModal.jsx = drag/click upload + file list (open/delete) + "Open Drive folder" button + not-connected empty state. Wired to a "Files" button in the ProjectBoard masthead next to KB/IS.

**Hard dependency:** Google Drive must be connected (Settings → Connectors) — feature shows a connect prompt otherwise. Accepted trade for Drive-backed vs native storage.

**Verified:** build compiles; convert-on-import proven live; both functions deployed. Full end-to-end web upload still wants a live user pass (the project-upload path needs a browser session JWT that can't be minted from CLI). Related: TDE-307 (Drive file manager: browse/rename/delete) is complementary. Connector reconsent caveat: KB f7be458a.
