/** 校验账号头像：不接受远程 URL、SVG，也不接受过大的内联图片。 */
export function avatarValidationError(value: unknown): string | null {
 if (typeof value !== 'string') return '头像格式不正确';
 if (/^(male-[123]|female-[123])$/.test(value) || value === '') return null;
 if (value.length > 180000) return '头像图片过大，请重新上传';
 const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
 if (!match || match[2].length % 4 !== 0) return '仅支持 PNG、JPG 和 WebP 头像';
 const bytes=Buffer.from(match[2],'base64');
 if (bytes.length < 20 || bytes.length > 128 * 1024) return '头像图片大小不正确';
 const valid=match[1]==='png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
   : match[1]==='jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255
   : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
 return valid ? null : '头像图片无法识别，请重新上传';
}
