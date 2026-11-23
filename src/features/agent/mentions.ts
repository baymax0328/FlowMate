export function activeMention(text: string, caret: number) {
  const before=text.slice(0,caret); const match=before.match(/@([^\s@]*)$/u);
  return match ? { start:before.length-match[0].length, end:caret, query:match[1] } : null;
}
export function insertMention(text:string, start:number, end:number, name:string) {
  const token=`@${name} `;return {text:text.slice(0,start)+token+text.slice(end),caret:start+token.length};
}
