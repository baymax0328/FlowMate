import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarValidationError } from '../server/modules/auth/avatar-validation.ts';

test('accepts all six presets and clearing the avatar',()=>{
 for(const id of ['male-1','male-2','male-3','female-1','female-2','female-3',''])assert.equal(avatarValidationError(id),null);
});
test('accepts normalized raster uploads',()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 assert.equal(avatarValidationError(png),null);
 const webp=Buffer.alloc(32);webp.write('RIFF');webp.write('WEBP',8);assert.equal(avatarValidationError('data:image/webp;base64,'+webp.toString('base64')),null);
});
test('rejects remote URLs, SVG, bad bytes, unknown presets and oversize uploads',()=>{
 for(const input of ['https://example.com/avatar.png','data:image/svg+xml;base64,PHN2Zz4=','male-4',12,null,'data:image/png;base64,'+Buffer.alloc(32).toString('base64'),'data:image/png;base64,'+'A'.repeat(180001)])assert.ok(avatarValidationError(input));
});
