//@ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration[]} */
const configs = [
  // Extension Host
  {
    name: 'extension',
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'out'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2'
    },
    externals: [
      { vscode: 'commonjs vscode' },
      // Don't bundle .node native modules - they're loaded at runtime
      function({ request }, callback) {
        if (/\.node$/.test(request)) {
          return callback(null, 'commonjs ' + request);
        }
        callback();
      }
    ],
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }]
        }
      ]
    },
    devtool: 'nosources-source-map',
    optimization: {
      minimize: true
    }
  },
  // Webview
  {
    name: 'webview',
    target: 'web',
    mode: 'none',
    entry: './web/main.ts',
    output: {
      path: path.resolve(__dirname, 'out'),
      filename: 'webview.js'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.web.json' } }]
        }
      ]
    },
    devtool: 'nosources-source-map',
    optimization: {
      minimize: true
    }
  }
];

module.exports = configs;
