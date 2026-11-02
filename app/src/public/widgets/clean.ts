/** 公开页去掉名字里的国旗 emoji，地区另有标签（与 page.tsx 同一写法） */
export const clean = (name: string) => name.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ').replace(/\s+/g, ' ').trim();
