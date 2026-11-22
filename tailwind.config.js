/** Tailwind v3 config — used only to prebuild static/css/tailwind.css.
 *  The Pi serves the generated file; it never needs Node.
 *  Rebuild after adding/changing classes: ./scripts/build-css.sh */
module.exports = {
  content: ['./templates/**/*.html', './static/js/**/*.js'],
  theme: { extend: {} },
  plugins: [],
};
