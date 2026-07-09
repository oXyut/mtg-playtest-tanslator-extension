import type { ProgressListener } from './progress';

/**
 * 画面右下に「日本語化中… done/total」のバッジを表示する。
 * 全件完了すると少し表示してからフェードアウトする。
 */
export function createProgressBadge(): ProgressListener {
  let badge: HTMLDivElement | null = null;
  let label: HTMLSpanElement | null = null;
  let bar: HTMLDivElement | null = null;
  let hideTimer: number | undefined;

  function ensure(): void {
    if (badge) return;
    badge = document.createElement('div');
    // サイト側の右下の浮遊UI(Moxfieldのスクロールボタン等)と重ならないよう左下に置く。
    // 合計バッジ(左下)とも重ならないよう1段上にする
    badge.style.cssText = [
      'position: fixed',
      'left: 16px',
      'bottom: 52px',
      'z-index: 2147483647',
      'pointer-events: none',
      'background: rgba(20, 20, 24, 0.88)',
      'color: #fff',
      'font: 12px/1.4 system-ui, sans-serif',
      'padding: 8px 12px 10px',
      'border-radius: 8px',
      'box-shadow: 0 2px 10px rgba(0,0,0,0.35)',
      'transition: opacity 0.4s',
      'opacity: 0',
      'min-width: 150px',
    ].join(';');

    label = document.createElement('span');
    badge.appendChild(label);

    const track = document.createElement('div');
    track.style.cssText =
      'margin-top: 6px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.25); overflow: hidden;';
    bar = document.createElement('div');
    bar.style.cssText =
      'height: 100%; width: 0%; border-radius: 2px; background: #7ec8ff; transition: width 0.2s;';
    track.appendChild(bar);
    badge.appendChild(track);

    document.documentElement.appendChild(badge);
  }

  return (done, total) => {
    ensure();
    clearTimeout(hideTimer);

    if (total === 0) {
      badge!.style.opacity = '0';
      return;
    }

    const finished = done >= total;
    label!.textContent = finished
      ? `日本語化 完了 (${total}枚)`
      : `日本語化中… ${done}/${total}`;
    bar!.style.width = `${Math.round((done / total) * 100)}%`;
    badge!.style.opacity = '1';

    if (finished) {
      hideTimer = window.setTimeout(() => {
        badge!.style.opacity = '0';
      }, 1500);
    }
  };
}
