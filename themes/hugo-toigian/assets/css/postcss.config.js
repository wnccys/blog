const path = require('path');
const themeDir = path.resolve(__dirname, "../../");

module.exports = {
  plugins: [
    require("postcss-import")({
      path: [
        themeDir,                            // 1. Look here for local files (assets/css/...)
        path.join(themeDir, "node_modules")  // 2. Look here for libraries (tailwindcss)
      ] 
    }),
    require("tailwindcss/nesting"),
    require("tailwindcss")(path.join(__dirname, "tailwind.config.js")),
    require("autoprefixer"),
  ],
};
