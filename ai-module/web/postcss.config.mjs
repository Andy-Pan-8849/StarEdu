/**
 * 文件：postcss.config.mjs
 * 作用：PostCSS 配置，只启用 Tailwind CSS 的 PostCSS 插件。
 */

const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
