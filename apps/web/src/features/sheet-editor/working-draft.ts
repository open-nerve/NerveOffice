/** 内存仍可供上传，但不能声称已持久保存；来源与页面共用这些事实，具体问题由准备/写入结果保留。 */
export type DraftMemoryReason = 'disabled' | 'unsupported' | 'existing-draft' | 'no-key' | 'quota' | 'unavailable' | 'fenced' | 'worker-failed' | 'paused'
