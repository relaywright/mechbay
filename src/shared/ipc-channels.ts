/**
 * IPC channel name constants. Naming scheme: `mechbay:${domain}:${action}`.
 * Grep-friendly across the entire codebase.
 */
export const IPC = {
  APP_MODE_GET: 'mechbay:app:modeGet',
  STATE_SUBSCRIBE: 'mechbay:state:subscribe',
  STATE_GET: 'mechbay:state:get',
  STATE_HEALTH_GET: 'mechbay:state:healthGet',
  DEPLOY_START: 'mechbay:deploy:start',
  DEPLOY_ABORT: 'mechbay:deploy:abort',
  LOG_STREAM: 'mechbay:log:stream',
  LOG_HISTORY: 'mechbay:log:history',
  REVIEW_APPROVE: 'mechbay:review:approve',
  REVIEW_REJECT: 'mechbay:review:reject',
  FS_READ_DIR: 'mechbay:fs:readDir',
  FS_READ_FILE: 'mechbay:fs:readFile',
  FACILITY_ADD_FROM_PICKER: 'mechbay:facility:addFromPicker',
  FACILITY_LINK: 'mechbay:facility:link',
  FACILITY_REMOVE: 'mechbay:facility:remove',
  FIELD_RESET: 'mechbay:field:reset',
  SCAN_PROJECTS: 'mechbay:scan:projects',
  RECOVERY_ZOMBIES: 'mechbay:recovery:zombies',
  SOUL_READ: 'mechbay:soul:read',
  SOUL_WRITE: 'mechbay:soul:write',
  MEMORY_READ: 'mechbay:memory:read',
  BULK_IMPORT_RUN: 'mechbay:bulk-import:run',
  COMPANION_CONFIGURE: 'mechbay:companion:configure',
  SECRETS_SET: 'mechbay:secrets:set',
  SECRETS_STATUS: 'mechbay:secrets:status',
  SETTINGS_UPDATE: 'mechbay:settings:update',
  DIFF_FILE_GET: 'mechbay:diff:fileGet'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
