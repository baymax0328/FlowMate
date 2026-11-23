import male1 from '../assets/profile-character-v2.png';
import male2 from '../assets/avatars/male-2.png';
import male3 from '../assets/avatars/male-3.png';
import female1 from '../assets/avatars/female-1.png';
import female2 from '../assets/avatars/female-2.png';
import female3 from '../assets/avatars/female-3.png';

export const AVATAR_OPTIONS = [
 { id:'male-1', label:'男士一', src:male1 }, { id:'male-2', label:'男士二', src:male2 }, { id:'male-3', label:'男士三', src:male3 },
 { id:'female-1', label:'女士一', src:female1 }, { id:'female-2', label:'女士二', src:female2 }, { id:'female-3', label:'女士三', src:female3 },
];
export function avatarSource(value: unknown): string {
 if (typeof value !== 'string') return male1;
 const option=AVATAR_OPTIONS.find(a=>a.id===value);
 if (option) return option.src;
 return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) && value.length <= 180000 ? value : male1;
}
