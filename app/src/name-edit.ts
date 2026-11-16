/** 改名框的起始文字：有自定义名用它；没起过名时用按钮上显示的默认名（浏览器 · 系统，多行合成一行） */
export const renameStart = (name: string, fallback?: string): string => name || fallback?.split('\n').filter(Boolean).join(' ') || '';
