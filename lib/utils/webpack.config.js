import webpack from 'webpack'
import StaticSiteGeneratorPlugin from 'static-site-generator-webpack-plugin'
import ExtractTextPlugin from 'extract-text-webpack-plugin'
import Config from 'webpack-configurator'
import path from 'path'
import _ from 'lodash'
import invariant from 'invariant'
import { StatsWriterPlugin } from 'webpack-stats-plugin'

const debug = require(`debug`)(`gatsby:webpack-config`)
const WebpackMD5Hash = require(`webpack-md5-hash`)
const OfflinePlugin = require(`offline-plugin`)
const ChunkManifestPlugin = require(`chunk-manifest-webpack-plugin`)
const { pagesDB, siteDB } = require(`../utils/globals`)
const { layoutComponentChunkName } = require(`./js-chunk-names`)
const babelConfig = require(`./babel-config`)

let modifyWebpackConfig
try {
  const gatsbyNodeConfig = path.resolve(process.cwd(), `./gatsby-node`)
  const nodeConfig = require(gatsbyNodeConfig)
  modifyWebpackConfig = nodeConfig.modifyWebpackConfig
} catch (e) {
  if (e.code !== `MODULE_NOT_FOUND` && !_.includes(e.Error, `gatsby-node`)) {
    console.log(e)
  }
}

// Five stages or modes:
//   1) develop: for `gatsby develop` command, hot reload and CSS injection into page
//   2) develop-html: same as develop without react-hmre in the babel config for html renderer
//   3) build-css: build styles.css file
//   4) build-html: build all HTML files
//   5) build-javascript: Build js chunks for Single Page App in production

module.exports = (program, directory, suppliedStage, webpackPort = 1500, pages = []) => {
  const babelStage = suppliedStage
  const stage = (suppliedStage === `develop-html`) ? `develop` : suppliedStage

  debug(`Loading webpack config for stage "${stage}"`)
  function output () {
    switch (stage) {
      case `develop`:
        return {
          path: directory,
          filename: `[name].js`,
          publicPath: `http://${program.host}:${webpackPort}/`,
        }
      case `build-css`:
        // Webpack will always generate a resultant javascript file.
        // But we don't want it for this step. Deleted by build-css.js.
        return {
          path: `${directory}/public`,
          filename: `bundle-for-css.js`,
          publicPath: program.prefixLinks ? `${siteDB().get(`config`).linkPrefix}/` : `/`,
        }
      case `build-html`:
        // A temp file required by static-site-generator-plugin. See plugins() below.
        // Deleted by build-html.js, since it's not needed for production.
        return {
          path: `${directory}/public`,
          filename: `render-page.js`,
          libraryTarget: `umd`,
        }
      case `build-javascript`:
        return {
          //filename: '[name].js',
          filename: `[name]-[chunkhash:8].js`,
          path: `${directory}/public`,
          publicPath: program.prefixLinks ? `${siteDB().get(`config`).linkPrefix}/` : `/`,
        }
      default:
        throw new Error(`The state requested ${stage} doesn't exist.`)
    }
  }

  function entry () {
    switch (stage) {
      case `develop`:
        return {
          commons: [
            `${require.resolve('webpack-dev-server/client')}?http://${program.host}:${webpackPort}/`,
            require.resolve(`webpack/hot/only-dev-server`),
            require.resolve(`react-hot-loader/patch`),
            `${directory}/.intermediate-representation/app`,
          ],
        }
      case `build-css`:
        return {
          main: `${directory}/.intermediate-representation/app`,
        }
      case `build-html`:
        return {
          main: `${__dirname}/static-entry`,
        }
      case `build-javascript`:
        return {
          app: `${directory}/.intermediate-representation/production-app`,
        }
      default:
        throw new Error(`The state requested ${stage} doesn't exist.`)
    }
  }

  function plugins () {
    switch (stage) {
      case `develop`:
        return [
          new webpack.optimize.OccurenceOrderPlugin(),
          new webpack.HotModuleReplacementPlugin(),
          new webpack.NoErrorsPlugin(),
          new webpack.DefinePlugin({
            'process.env': {
              NODE_ENV: JSON.stringify(process.env.NODE_ENV ? process.env.NODE_ENV : `development`),
            },
            __PREFIX_LINKS__: program.prefixLinks,
            __LINK_PREFIX__: JSON.stringify(siteDB().get(`config`).linkPrefix),
          }),
        ]
      case `build-css`:
        return [
          new webpack.DefinePlugin({
            'process.env': {
              NODE_ENV: JSON.stringify(process.env.NODE_ENV ? process.env.NODE_ENV : `production`),
            },
            __PREFIX_LINKS__: program.prefixLinks,
            __LINK_PREFIX__: JSON.stringify(siteDB().get(`config`).linkPrefix),
          }),
          new ExtractTextPlugin(`styles.css`),
        ]
      case `build-html`:
        return [
          new StaticSiteGeneratorPlugin(`render-page.js`, pages),
          new webpack.DefinePlugin({
            'process.env': {
              NODE_ENV: JSON.stringify(process.env.NODE_ENV ? process.env.NODE_ENV : `production`),
            },
            __PREFIX_LINKS__: program.prefixLinks,
            __LINK_PREFIX__: JSON.stringify(siteDB().get(`config`).linkPrefix),
          }),
          new ExtractTextPlugin(`styles.css`),
        ]
      case `build-javascript`: {
        // Get array of page template component names.
        let components = _.uniq(Array.from(pagesDB().values()).map(page => page.component))
        components = components.map(component => layoutComponentChunkName(component))
        return [
          // Moment.js includes 100s of KBs of extra localization data
          // by default in Webpack that most sites don't want.
          // This line disables that.
          // TODO remove this now that loading moment.js isn't common w/ new
          // graphql data layer?
          new webpack.IgnorePlugin(/^\.\/locale$/, /moment$/),
          new WebpackMD5Hash(),
          new webpack.optimize.DedupePlugin(),
          new webpack.optimize.OccurenceOrderPlugin(),
          // Extract "commons" chunk from the app entry and all
          // page components.
          new webpack.optimize.CommonsChunkPlugin({
            name: `commons`,
            chunks: [
              `app`,
              ...components,
            ],
            // The more page components there are, the higher we raise the bar
            // for merging in page-specific JS libs into the commons chunk. The
            // two principles here is a) keep the TTI (time to interaction) as
            // low as possible so that means keeping commons.js small with
            // critical code (e.g. React) and b) is we want to push JS
            // parse/eval work as close as possible to when it's used.  Since
            // most people don't navigate to most pages, take tradeoff of
            // loading/evaling modules multiple times over loading/evaling lots
            // of unused code on the initial opening of the app.
            minChunks: Math.floor(components.length / 2),
          }),
          new webpack.DefinePlugin({
            'process.env': {
              NODE_ENV: JSON.stringify(process.env.NODE_ENV ? process.env.NODE_ENV : `production`),
            },
            __PREFIX_LINKS__: program.prefixLinks,
            __LINK_PREFIX__: JSON.stringify(siteDB().get(`config`).linkPrefix),
          }),
          new ExtractTextPlugin(`styles.css`),
          new OfflinePlugin({
            //AppCache: false,
            publicPath: program.prefixLinks ? `${siteDB().get(`config`).linkPrefix}/` : `/`,
            relativePaths: false,
            ServiceWorker: {
              events: true,
            },
          }),
          new webpack.optimize.UglifyJsPlugin(),
          new StatsWriterPlugin(),
          //new ChunkManifestPlugin({
            //filename: "chunk-manifest.json",
            //manifestVariable: "webpackManifest"
          //}),
          // inline manifest in head, atom.xml as "page"
        ]
      }
      default:
        throw new Error(`The state requested ${stage} doesn't exist.`)
    }
  }

  function resolve () {
    return {
      extensions: [
        ``,
        `.js`,
        `.jsx`,
        `.cjsx`,
        `.coffee`,
      ],
      // Hierarchy of directories for Webpack to look for module.
      // First is the site directory.
      // Then in the special directory of isomorphic modules Gatsby ships with.
      // Then the site's node_modules directory
      // and last the Gatsby node_modules directory.
      root: [
        directory,
        path.resolve(__dirname, `..`, `isomorphic`),
      ],
      modulesDirectories: [
        `${directory}/node_modules`,
        `${directory}/node_modules/gatsby/node_modules`,
        `node_modules`,
      ],
    }
  }

  function devtool () {
    switch (stage) {
      case `develop`:
        return `eval`
      case `build-html`:
        return false
      case `build-javascript`:
        return `source-map`
      default:
        return false
    }
  }

  function module (config) {
    // Common config for every env.
    config.loader(`cjsx`, {
      test: /\.cjsx$/,
      loaders: [`coffee`, `cjsx`],
    })
    config.loader(`js`, {
      test: /\.jsx?$/, // Accept either .js or .jsx files.
      exclude: /(node_modules|bower_components)/,
      loader: `babel`,
      query: babelConfig(program, babelStage),
    })
    config.loader(`coffee`, {
      test: /\.coffee$/,
      loader: `coffee`,
    })
    config.loader(`json`, {
      test: /\.json$/,
      loaders: [`json`],
    })
    // Image loaders.
    config.loader(`images`, {
      test: /\.(jpe?g|png|gif|svg)(\?.*)?$/i,
      loaders: [
        `url-loader?limit=10000`,
      ],
    })
    // Font loaders.
    config.loader(`woff`, {
      test: /\.woff(2)?(\?v=[0-9]\.[0-9]\.[0-9])?$/,
      loader: `url-loader?limit=10000&minetype=application/font-woff`,
    })
    config.loader(`ttf`, {
      test: /\.(ttf)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
      loader: `file-loader`,
    })
    config.loader(`eot`, {
      test: /\.(eot)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
      loader: `file-loader`,
    })

    const cssModulesConf = `css?modules&minimize&importLoaders=1`
    const cssModulesConfDev =
      `${cssModulesConf}&sourceMap&localIdentName=[name]---[local]---[hash:base64:5]`

    switch (stage) {
      case `develop`:

        config.loader(`css`, {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          loaders: [`style`, `css`, `postcss`],
        })

        // CSS modules
        config.loader(`cssModules`, {
          test: /\.module\.css$/,
          loaders: [`style`, cssModulesConfDev, `postcss`],
        })

        config.merge({
          postcss (wp) {
            return [
              require(`postcss-import`)({ addDependencyTo: wp }),
              require(`postcss-cssnext`)({ browsers: `last 2 versions` }),
              require(`postcss-browser-reporter`),
              require(`postcss-reporter`),
            ]
          },
        })
        return config

      case `build-css`:
        config.loader(`css`, {
          test: /\.css$/,
          loader: ExtractTextPlugin.extract([`css?minimize`, `postcss`]),
          exclude: /\.module\.css$/,
        })

        // CSS modules
        config.loader(`cssModules`, {
          test: /\.module\.css$/,
          loader: ExtractTextPlugin.extract(`style`, [cssModulesConf, `postcss`]),
        })
        config.merge({
          postcss: [
            require(`postcss-import`)(),
            require(`postcss-cssnext`)({
              browsers: `last 2 versions`,
            }),
          ],
        })
        return config

      case `build-html`:
        // We don't deal with CSS at all when building the HTML.
        // The 'null' loader is used to prevent 'module not found' errors.
        // On the other hand CSS modules loaders are necessary.

        config.loader(`css`, {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          loader: `null`,
        })

        // CSS modules
        config.loader(`cssModules`, {
          test: /\.module\.css$/,
          loader: ExtractTextPlugin.extract(`style`, [cssModulesConf, `postcss`]),
        })

        return config

      case `build-javascript`:
        // We don't deal with CSS at all when building the javascript.
        // The 'null' loader is used to prevent 'module not found' errors.
        // On the other hand CSS modules loaders are necessary.

        config.loader(`css`, {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          loader: `null`,
        })

        // CSS modules
        config.loader(`cssModules`, {
          test: /\.module\.css$/,
          loader: ExtractTextPlugin.extract(`style`, [cssModulesConf, `postcss`]),
        })

        return config

      default:
        return config
    }
  }

  const config = new Config()

  config.merge({
    context: `${directory}/pages`,
    node: {
      __filename: true,
    },
    entry: entry(),
    debug: true,
    profile: stage === `production`,
    devtool: devtool(),
    output: output(),
    resolveLoader: {
      // Hierarchy of directories for Webpack to look for loaders.
      // First is the /loaders/ directory in the site.
      // Then in the special directory of loaders Gatsby ships with.
      // Then the site's node_modules directory
      // and last the Gatsby node_modules directory.
      root: [
        path.resolve(directory, `loaders`),
        path.resolve(__dirname, `..`, `loaders`),
        path.resolve(directory, `node_modules`),
        path.resolve(directory, `node_modules/gatsby/node_modules`),
      ],
    },
    plugins: plugins(),
    resolve: resolve(),
  })

  if (modifyWebpackConfig) {
    const modifiedWebpackConfig = modifyWebpackConfig(module(config), stage)
    invariant(_.isObject(modifiedWebpackConfig),
              `
              You must return an object when modifying the Webpack config.
              Returned: ${modifiedWebpackConfig}
              stage: ${stage}
              `)
    return modifiedWebpackConfig
  } else {
    return module(config)
  }
}
