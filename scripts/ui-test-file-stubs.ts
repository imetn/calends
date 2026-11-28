// 组件测试里文件中心的依赖：纯函数用真实实现，上传、选择文件、文件卡用空实现（订阅没有文件时界面与原来一致）
import { fileBadgeKind, fileReceiptPerson, filesAt, filesForReceipt, filesOf } from '../shared/files.ts';

export const fileStubs = {
  filesOf,
  filesAt,
  filesForReceipt,
  fileBadgeKind,
  fileReceiptPerson,
  canAttach: () => false,
  useUpload: () => ({ pending: [], upload() {}, uploadAsync: async () => [] }),
  useFilePicker: () => [null, () => {}],
  useChargeFiles: () => ({ group: null, moveTo: async () => {}, uploading: false }),
  useReceiptFiles: () => ({ group: null, syncAfterSave: async () => {}, uploading: false }),
  relinkFile: async () => {},
  FilesCard: 'FilesCard',
  FileSheet: 'FileSheet',
  FileBadges: 'FileBadges',
  ReceiptScopeTag: 'ReceiptScopeTag',
  Paperclip: 'Paperclip',
};
