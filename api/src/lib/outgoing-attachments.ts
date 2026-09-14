import type { RawAttachment } from './inbox-archive';
import { DRAFT_FILE_MAX_BYTES, DRAFT_FILES_MAX_BYTES } from './mail-draft-files';

export function outgoingAttachments(files: RawAttachment[] = []) {
  if (files.length > 20) throw new Error('Maximum 20 attachments');
  let total = 0;
  return files.map((file, index) => {
    let bytes: Uint8Array;
    if (file.content instanceof ArrayBuffer) bytes = new Uint8Array(file.content);
    else if (typeof file.content === 'string') {
      if (file.encoding === 'base64') {
        const decoded = atob(file.content);
        bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      } else bytes = new TextEncoder().encode(file.content);
    } else throw new Error('Attachment content is missing');
    total += bytes.byteLength;
    if (bytes.byteLength > DRAFT_FILE_MAX_BYTES || total > DRAFT_FILES_MAX_BYTES) throw new Error('Attachments exceed size limits');
    const filename = (file.filename || `attachment-${index + 1}`).replace(/[\\/\u0000-\u001f]/g, '-').slice(0, 120);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { filename, content: btoa(binary), mimeType: file.mimeType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType) ? file.mimeType : 'application/octet-stream' };
  });
}
