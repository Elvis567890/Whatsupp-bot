const { join } = require('path');

module.exports = {
  // This ensures Puppeteer installs the browser in a persistent folder
  // within your project, solving the Render cache permission issues.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
