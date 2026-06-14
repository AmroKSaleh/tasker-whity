# Tasks: Link Shortener API

**Input**: Design documents from `/specs/001-link-shortener/`
**Prerequisites**: plan.md (required), research.md

## Phase 3.1: Setup
- [x] T001 Create project structure per implementation plan
- [x] T002 Initialize Node project with dependencies
- [ ] T003 [P] Configure ESLint and Prettier

## Phase 3.2: Tests First (TDD)
- [ ] T004 [P] Contract test POST /api/links in tests/contract/test_links_post.py
- [ ] T005 [P] Integration test redirect flow in tests/integration/test_redirect.py

## Phase 3.3: Core Implementation
- [ ] T006 [P] Link model in src/models/link.py
- [ ] T007 LinkService CRUD in src/services/link_service.py
- [ ] T008 POST /api/links endpoint in src/api/links.py

## Dependencies
- Tests (T004-T005) before implementation (T006-T008)
- T006 blocks T007

## Parallel Example
Launch T004-T005 together.
