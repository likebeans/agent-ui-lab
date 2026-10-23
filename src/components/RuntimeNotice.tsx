import { BookOpen } from 'lucide-react';
import { STATIC_MODE } from '../../shared/runtime';
import { docHref } from '../../shared/doc-navigation';

export function RuntimeNotice() {
  if (!STATIC_MODE) return null;
  return (
    <aside className="runtime-notice" aria-label="当前运行模式">
      <strong>静态学习版</strong>
      <span>消息与工具在浏览器内运行；iframe 通信真实执行。体验 HTTP / SSE 请在本地启动。</span>
      <a href={docHref('real-development', '5-准备部署')}>
        模式说明 <BookOpen size={13} aria-hidden="true" />
      </a>
    </aside>
  );
}
