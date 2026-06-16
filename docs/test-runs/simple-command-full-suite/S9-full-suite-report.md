# Simple Command Full Suite Report

Generated: 2026-06-15T17:37:36.093Z
Realtime-2 connected: false

## Summary

- Total scenarios/cards: 138
- Passed: 134
- Failed: 0
- Skipped: 1
- Unsupported: 0
- Blocked: 3

## Milestones

| Milestone | Report | Total | Passed | Failed | Skipped | Unsupported | Blocked |
|---|---|---:|---:|---:|---:|---:|---:|
| S0 Simple Command Intent Card Harness | docs/test-runs/simple-command-intent-cards/S0-intent-card-report.json | 62 | 62 | 0 | 0 | 0 | 0 |
| S1 Desktop App and Window Real Simulation | docs/test-runs/simple-command-desktop/S1-desktop-window-report.json | 6 | 3 | 0 | 1 | 0 | 2 |
| S2 Files and Documents | docs/test-runs/simple-command-files/S2-files-documents-report.json | 13 | 13 | 0 | 0 | 0 | 0 |
| S3 Browser and Page Commands | docs/test-runs/simple-command-browser/S3-browser-page-report.json | 10 | 9 | 0 | 0 | 0 | 1 |
| S4 Music, Media, and Video | docs/test-runs/simple-command-media/S4-media-video-report.json | 11 | 11 | 0 | 0 | 0 | 0 |
| S5 System, Clipboard, Notification, Speech, and Screenshot | docs/test-runs/simple-command-system/S5-system-desktop-report.json | 12 | 12 | 0 | 0 | 0 | 0 |
| S6 Mail, Calendar, Reminders, Notes, and Copy Drafts | docs/test-runs/simple-command-productivity/S6-productivity-report.json | 11 | 11 | 0 | 0 | 0 | 0 |
| S7 Task, Confirmation, and Low-Risk Shell | docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json | 8 | 8 | 0 | 0 | 0 | 0 |
| S8 Negative, Safety, and Clarification | docs/test-runs/simple-command-safety/S8-negative-safety-report.json | 5 | 5 | 0 | 0 | 0 | 0 |

## Coverage

### S0

- By domain: {"media":7,"desktop":8,"files":11,"browser":4,"productivity":5,"system":7,"alias":5,"task":7,"clarification":5,"safety":3}
- By risk: {"local_open":21,"system_change":9,"read":12,"local_write":9,"browser_submit":2,"external_send":3,"shell":3,"coding_agent":3}
- By command type: {"music_play_song":5,"music_open":1,"video_play":1,"app_open":3,"app_focus":1,"window_auto_arrange":1,"window_minimize_unrelated":1,"window_close_all":1,"desktop_show":1,"ambiguous":1,"file_list":1,"file_search":3,"file_create_folder":1,"file_rename":1,"file_move":1,"file_trash":1,"file_read":1,"document_extract":2,"document_folder_digest":1,"document_prepare_edit":1,"browser_open_url":1,"browser_isolated_open_url":1,"browser_fill_form":1,"browser_click":1,"email_search":1,"email_draft":1,"email_send":1,"calendar_create":1,"calendar_search":1,"system_set_volume":2,"system_set_brightness":1,"system_set_dark_mode":1,"system_open_settings":1,"advanced_shell_command":3,"alias_create":3,"alias_list":1,"alias_delete":1,"task_list":1,"task_status":1,"task_cancel":1,"coding_agent_start":4,"thing":1,"delete":1,"send":1,"music":1}
- By execution mode: {"dry_run":33,"confirmation_only":22,"denial_only":7}

### S1

- By domain: {"S1":6}
- By risk: {"unknown":6}
- By command type: {"preflight":2,"protection":1,"app":1,"desktop":1,"excluded":1}
- By execution mode: {"safe_real":6}

### S2

- By domain: {"S2":13}
- By risk: {"unknown":12,"local_write":1}
- By command type: {"file":10,"document":3}
- By execution mode: {"safe_real":13}

### S3

- By domain: {"S3":10}
- By risk: {"unknown":9,"browser_submit":1}
- By command type: {"browser":9,"local-api-origin-protection":1}
- By execution mode: {"safe_real":10}

### S4

- By domain: {"S4":11}
- By risk: {"unknown":11}
- By command type: {"music":3,"spotify":3,"netease":1,"qq":1,"media-key":1,"video":2}
- By execution mode: {"safe_real":11}

### S5

- By domain: {"S5":12}
- By risk: {"unknown":11,"system_change":1}
- By command type: {"system":8,"clipboard":1,"screenshot":1,"keyboard":1,"safety":1}
- By execution mode: {"safe_real":12}

### S6

- By domain: {"S6":11}
- By risk: {"unknown":7,"external_send":4}
- By command type: {"email":4,"mac-mail-draft-confirmation":1,"calendar":1,"mac-calendar-confirmation":1,"mac-reminder":1,"mac-note":1,"copy":2}
- By execution mode: {"safe_real":11}

### S7

- By domain: {"S7":8}
- By risk: {"unknown":8}
- By command type: {"shell":3,"task":2,"confirmation":2,"coding-agent":1}
- By execution mode: {"safe_real":8}

### S8

- By domain: {"S8":5}
- By risk: {"unknown":4,"browser_submit":1}
- By command type: {"intent-cards":1,"document":1,"file":1,"browser":1,"shell":1}
- By execution mode: {"safe_real":5}

## Cleanup And Safety

- S3 isolated Chrome profiles running: no
- S4 isolated Chrome profiles running: no
- Ignored screenshot artifacts: 1
- Report secret scan: passed

