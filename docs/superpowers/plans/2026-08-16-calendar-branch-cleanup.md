# Calendar Integration Branch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a clean Calendar Integration branch from `main` containing only the Calendar UI changes and regression coverage.

**Architecture:** Preserve the existing admin calendar architecture and API contracts. Keep Calendar changes isolated from the unrelated Resend, public-form, and styling work that accumulated on the old milestone branch.

**Tech Stack:** Vanilla JavaScript admin UI, existing API client, Vitest regression tests, GitHub branches.

## Global Constraints

- Do not rebuild the application.
- Do not modify `main`.
- Preserve existing Calendar API endpoints and authentication behavior.
- Do not carry unrelated Resend/public-form/styling changes into the clean Calendar branch.

---

### Task 1: Establish clean Calendar branch

**Files:**
- Create: `admin/js/pages/calendar.js`
- Create: `admin/js/pages/calendar.test.js`
- Create: `docs/superpowers/plans/2026-08-16-calendar-branch-cleanup.md`

- [ ] **Step 1: Branch from current `main`**

Create `feature/milestone-5-calendar-clean` from the pinned `main` commit.

- [ ] **Step 2: Add Calendar implementation**

Carry forward only the Calendar implementation from the existing milestone branch.

- [ ] **Step 3: Add regression coverage**

Cover the `nds.dispatch.calendar` session-storage state used for month, technician, and status filters.

- [ ] **Step 4: Verify dependency**

Confirm `backend/src/routes/bookings.js` on `main` already exposes `GET /calendar`, booking detail, and update endpoints required by the Calendar UI.

- [ ] **Step 5: Verify branch isolation**

Compare the clean branch with `main` and confirm only Calendar files plus this plan differ.

- [ ] **Step 6: Commit**

Commit as `feat: isolate calendar integration from unrelated work`.
