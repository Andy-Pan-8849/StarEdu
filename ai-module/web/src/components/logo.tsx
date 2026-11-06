/**
 * 文件：components/logo.tsx
 * 作用：品牌图标（灯塔把光射向一弧星星）。页头和登录页用它；浏览器标签页图标是
 *   app/icon.svg（Next.js 会自动识别）。
 * 主要思想：图标直接内联成 SVG，不依赖 public/ 目录里的静态文件（Docker 镜像只带
 *   standalone 产物，不带 public/）。图形与仓库根目录 assets/logo/logo-mark.svg 完全一致，
 *   改图标时两处一起改。纯装饰，所以对读屏软件隐藏（旁边已有文字“StarIT”）。
 */

/** 圆形品牌图标；size 是边长（像素），默认 28。 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 200"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <circle cx="100" cy="100" r="96" fill="#4338CA" />
      <g fill="#FBBF24">
        <polygon
          points="0,-20 4.7,-6.47 19.02,-6.18 7.61,2.47 11.76,16.18 0,8 -11.76,16.18 -7.61,2.47 -19.02,-6.18 -4.7,-6.47"
          transform="translate(44.6 68) rotate(-60) scale(0.6)"
        />
        <polygon
          points="0,-20 4.7,-6.47 19.02,-6.18 7.61,2.47 11.76,16.18 0,8 -11.76,16.18 -7.61,2.47 -19.02,-6.18 -4.7,-6.47"
          transform="translate(68 44.6) rotate(-30) scale(0.75)"
        />
        <polygon
          points="0,-20 4.7,-6.47 19.02,-6.18 7.61,2.47 11.76,16.18 0,8 -11.76,16.18 -7.61,2.47 -19.02,-6.18 -4.7,-6.47"
          transform="translate(100 36) scale(0.95)"
        />
        <polygon
          points="0,-20 4.7,-6.47 19.02,-6.18 7.61,2.47 11.76,16.18 0,8 -11.76,16.18 -7.61,2.47 -19.02,-6.18 -4.7,-6.47"
          transform="translate(132 44.6) rotate(30) scale(0.75)"
        />
        <polygon
          points="0,-20 4.7,-6.47 19.02,-6.18 7.61,2.47 11.76,16.18 0,8 -11.76,16.18 -7.61,2.47 -19.02,-6.18 -4.7,-6.47"
          transform="translate(155.4 68) rotate(60) scale(0.6)"
        />
      </g>
      <g transform="translate(0 8) translate(100 150) scale(1.1) translate(-100 -150)">
        <polygon points="94,86 66,73 66,99 94,92" fill="#FDE68A" fillOpacity="0.5" />
        <polygon points="106,86 134,73 134,99 106,92" fill="#FDE68A" fillOpacity="0.5" />
        <path d="M64 150 Q82 134 100 140 Q118 134 136 150 Z" fill="#818CF8" />
        <polygon points="86,146 114,146 107,96 93,96" fill="#fff" />
        <polygon points="91.32,108 108.68,108 110.08,118 89.92,118" fill="#4338CA" />
        <polygon points="88.24,128 111.76,128 112.88,136 87.12,136" fill="#4338CA" />
        <rect x="88" y="94" width="24" height="3.5" fill="#fff" />
        <rect x="92" y="83" width="16" height="11" fill="#FBBF24" />
        <polygon points="89,83 111,83 100,72" fill="#fff" />
      </g>
    </svg>
  );
}
