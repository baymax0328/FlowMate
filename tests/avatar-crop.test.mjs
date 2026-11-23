import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarCropRect } from '../src/app/avatar-crop.ts';

test('landscape and portrait avatars start centered and keep a square crop', () => {
  assert.deepEqual(avatarCropRect(800, 400, {x:400,y:200,zoom:1}), {x:200,y:0,side:400,center:{x:400,y:200,zoom:1}});
  assert.deepEqual(avatarCropRect(400, 800, {x:200,y:400,zoom:1}), {x:0,y:200,side:400,center:{x:200,y:400,zoom:1}});
});
test('dragging beyond image edges never exposes empty pixels at any zoom', () => {
  for (const [w,h] of [[800,400],[400,800],[200,200]]) {
    for (const zoom of [.5,1,1.7,4,9]) {
      for (const x of [-1000,0,100,2000]) for (const y of [-1000,0,100,2000]) {
        const r=avatarCropRect(w,h,{x,y,zoom});
        assert.ok(r.x>=0 && r.y>=0);
        assert.ok(r.x+r.side<=w+.000001 && r.y+r.side<=h+.000001);
        assert.ok(r.center.zoom>=1 && r.center.zoom<=4);
      }
    }
  }
});
test('zooming preserves the chosen center where the image boundaries allow it', () => {
  const r=avatarCropRect(800,400,{x:550,y:160,zoom:2});
  assert.deepEqual(r,{x:450,y:60,side:200,center:{x:550,y:160,zoom:2}});
  const reset=avatarCropRect(800,400,{x:400,y:200,zoom:1});
  assert.equal(reset.side,400);
});
