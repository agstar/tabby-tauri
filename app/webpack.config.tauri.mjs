import * as fs from 'fs'
import * as path from 'path'
import wp from 'webpack'
import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

import { AngularWebpackPlugin } from '@ngtools/webpack'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'

const linkerPlugin = createEs2015LinkerPlugin({
    linkerJitMode: true,
    fileSystem: {
        resolve: path.resolve,
        exists: fs.existsSync,
        dirname: path.dirname,
        relative: path.relative,
        readFile: fs.readFileSync,
    },
})

const outputPath = path.resolve(__dirname, '../tauri-app/dist')
const inlineSvgIssuer = /\.(?:ts|js|pug)(?:\?.*)?$/

const packageNodeModules = [
    '../tabby-core/node_modules',
    '../tabby-settings/node_modules',
    '../tabby-terminal/node_modules',
    '../tabby-local/node_modules',
    '../tabby-ssh/node_modules',
    '../tabby-tauri/node_modules',
    '../tauri-app/node_modules',
].map(x => path.join(__dirname, x))

class TauriIndexHtmlPlugin {
    apply (compiler) {
        compiler.hooks.afterEmit.tap('TauriIndexHtmlPlugin', () => {
            fs.mkdirSync(outputPath, { recursive: true })
            fs.writeFileSync(
                path.join(outputPath, 'index.html'),
                [
                    '<!doctype html>',
                    '<html lang="en">',
                    '  <head>',
                    '    <meta charset="UTF-8" />',
                    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
                    '    <title>Tabby Tauri</title>',
                    '    <style>',
                    '      html, body { margin: 0; width: 100%; height: 100%; background: #000e17; }',
                    '      body { color: #a1c5e4; font-family: "Source Sans Pro", "Segoe UI", system-ui, sans-serif; overflow: hidden; }',
                    '      app-root { display: block; min-width: 100vw; min-height: 100vh; background: #1D272D; }',
                    '      .preload-logo { position: fixed; inset: 0; display: flex; background-image: radial-gradient(#3a66820a 0%, #000e17 30%, black 100%); background-color: black; }',
                    '      .preload-logo > div { width: 200px; margin: auto; text-align: center; }',
                    '      .tabby-title { margin: 12px 0 0; color: #a1c5e4; font-size: 32px; font-weight: normal; }',
                    '      .preload-logo .progress { height: 3px; margin: 10px 50px; background: rgba(0, 0, 0, .25); }',
                    '      .preload-logo .bar { height: 3px; background: #a1c5e4; box-shadow: 0 0 2px #ffffff1f; }',
                    '    </style>',
                    '  </head>',
                    '  <body>',
                    '    <style id="custom-css"></style>',
                    '    <app-root>',
                    '      <div class="preload-logo">',
                    '        <div>',
                    '          <h1 class="tabby-title">Tabby Tauri</h1>',
                    '          <div class="progress"><div class="bar" style="width: 0%"></div></div>',
                    '        </div>',
                    '      </div>',
                    '    </app-root>',
                    '    <script>',
                    '      globalThis.global = globalThis;',
                    '      globalThis.setImmediate = globalThis.setImmediate || ((cb, ...args) => setTimeout(cb, 0, ...args));',
                    '      globalThis.clearImmediate = globalThis.clearImmediate || ((id) => clearTimeout(id));',
                    '    </script>',
                    '    <script src="bundle.tauri.js"></script>',
                    '  </body>',
                    '</html>',
                    '',
                ].join('\n'),
            )
        })
    }
}

export default () => {
    const isDevelopmentBuild = !!process.env.TABBY_DEV

    return {
        name: 'tabby-tauri-renderer',
        target: 'web',
        entry: {
            'bundle.tauri': path.resolve(__dirname, 'src/entry.tauri.ts'),
        },
        mode: isDevelopmentBuild ? 'development' : 'production',
        optimization: {
            minimize: !isDevelopmentBuild,
            concatenateModules: !isDevelopmentBuild,
        },
        context: __dirname,
        devtool: isDevelopmentBuild ? 'source-map' : false,
        output: {
            path: outputPath,
            pathinfo: isDevelopmentBuild,
            clean: !isDevelopmentBuild,
            filename: '[name].js',
            chunkFilename: '[name].js',
            publicPath: 'auto',
        },
        resolve: {
            modules: [
                ...['src/', 'node_modules', '../node_modules', 'assets/'].map(x => path.join(__dirname, x)),
                ...packageNodeModules,
            ],
            extensions: ['.ts', '.js'],
            alias: {
                'tabby-core': path.resolve(__dirname, '../tabby-core/src'),
                'tabby-settings': path.resolve(__dirname, '../tabby-settings/src'),
                'tabby-terminal': path.resolve(__dirname, '../tabby-terminal/src'),
                'tabby-local': path.resolve(__dirname, '../tabby-local/src'),
                'tabby-ssh': path.resolve(__dirname, '../tabby-ssh/src'),
                'tabby-tauri': path.resolve(__dirname, '../tabby-tauri/src'),
                '@luminati-io/socksv5': path.resolve(__dirname, 'src/tauri-guards/socksv5.ts'),
                'russh': path.resolve(__dirname, 'src/tauri-guards/russh.ts'),
                'windows-native-registry': path.resolve(__dirname, 'src/tauri-guards/windows-native-registry.ts'),
                'fs/promises': path.resolve(__dirname, 'src/tauri-providers/fs-promises.ts'),
                'ngx-translate-messageformat-compiler': path.resolve(__dirname, 'src/tauri-providers/translate-messageformat-compiler.ts'),
            },
            fallback: {
                assert: path.resolve(__dirname, 'src/tauri-polyfills/assert.js'),
                buffer: false,
                child_process: false,
                constants: false,
                crypto: false,
                dns: false,
                fs: path.resolve(__dirname, 'src/tauri-guards/fs.ts'),
                http: path.resolve(__dirname, 'src/tauri-guards/http.ts'),
                https: path.resolve(__dirname, 'src/tauri-guards/https.ts'),
                module: false,
                net: path.resolve(__dirname, 'src/tauri-providers/net.ts'),
                os: path.resolve(__dirname, 'src/tauri-providers/os.ts'),
                path: path.resolve(__dirname, 'src/tauri-polyfills/path.ts'),
                readline: path.resolve(__dirname, 'src/tauri-polyfills/readline.ts'),
                stream: false,
                tls: path.resolve(__dirname, 'src/tauri-guards/tls.ts'),
                tty: false,
                url: false,
                querystring: false,
                util: path.resolve(__dirname, 'src/tauri-polyfills/util.ts'),
            },
        },
        module: {
            rules: [
                {
                    test: /\.(m?)js$/,
                    loader: 'babel-loader',
                    options: {
                        plugins: [linkerPlugin],
                        compact: false,
                        cacheDirectory: true,
                    },
                    resolve: {
                        fullySpecified: false,
                    },
                },
                {
                    test: /\.ts$/,
                    use: {
                        loader: '@ngtools/webpack',
                    },
                },
                { test: /\.pug$/, use: ['apply-loader', { loader: 'pug-loader', options: { pretty: true } }] },
                { test: /\.scss$/, resourceQuery: /ngResource/, use: [{ loader: 'raw-loader', options: { esModule: false } }, 'sass-loader'] },
                { test: /\.css$/, resourceQuery: /ngResource/, use: [{ loader: 'raw-loader', options: { esModule: false } }] },
                { test: /(?:\.component|theme\.new)\.scss$/, resourceQuery: { not: [/ngResource/] }, use: [{ loader: 'raw-loader', options: { esModule: false } }, 'sass-loader'] },
                { test: /\.scss$/, resourceQuery: { not: [/ngResource/] }, exclude: /(?:\.component|theme\.new)\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
                { test: /\.css$/, resourceQuery: { not: [/ngResource/] }, use: ['style-loader', 'css-loader'] },
                { test: /\.svg$/, issuer: inlineSvgIssuer, use: ['svg-inline-loader'] },
                {
                    test: /\.(png|ogg|ttf|eot|otf|woff|woff2)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                    type: 'asset',
                },
                {
                    test: /\.svg$/,
                    issuer: { not: [inlineSvgIssuer] },
                    type: 'asset',
                },
                { test: /\.yaml$/, use: ['yaml-loader'] },
                { test: /\.po$/, use: [{ loader: 'json-loader' }, { loader: 'po-gettext-loader' }] },
            ],
        },
        externals: {
            '@electron/remote': '{}',
            electron: '{}',
            keytar: '{}',
        },
        plugins: [
            new wp.DefinePlugin({
                'process.type': '"renderer"',
                'process.env.TABBY_DEV': JSON.stringify(process.env.TABBY_DEV ?? ''),
            }),
            new wp.ProvidePlugin({
                Buffer: ['buffer', 'Buffer'],
                process: [path.resolve(__dirname, 'src/tauri-providers/process.ts'), 'default'],
            }),
            new AngularWebpackPlugin({
                tsconfig: path.resolve(__dirname, '../tsconfig.tauri.json'),
                directTemplateLoading: false,
                jitMode: true,
            }),
            new TauriIndexHtmlPlugin(),
        ],
    }
}
