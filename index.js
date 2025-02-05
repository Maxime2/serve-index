/*!
 * serve-index
 * Copyright(c) 2011 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var accepts = require('accepts');
var prettyBytes = require('@gerhobbelt/pretty-bytes');
var createError = require('http-errors');
var debug = require('debug')('serve-index');
var escapeHtml = require('escape-html');
var fs = require('fs')
  , path = require('path')
  , normalize = path.normalize
  , sep = path.sep
  , extname = path.extname
  , join = path.join;
var Batch = require('batch');
var mime = require('mime-types');
var parseUrl = require('parseurl');
var resolve = require('path').resolve;

/**
 * Module exports.
 * @public
 */

module.exports = serveIndex;

/*!
 * Icon cache.
 */

var cache = {};

/*!
 * Default template.
 */

var defaultTemplate = join(__dirname, 'public', 'directory.html');
var defaultTemplates = {
  plain: {
    page: '{files}\n',
    list: '{header}{items}',
    header: '',
    item: '{file.name}\n'
  },
  html: {
    list: '<ul id="files" class="view-{view}">{header}{items}</ul>',
    header: '<li class="header">'
      + '<span class="name">Name</span>'
      + '<span class="size">Size</span>'
      + '<span class="date">Modified</span>'
      + '</li>',
    item: '<li><a href="{path}" class="{classes}" title="{file.name}">'
      + '<span class="name">{file.name}</span>'
      + '<span class="size">{file.size}</span>'
      + '<span class="date">{file.lastModified}</span>'
      + '</a></li>'
  }
}

/*!
 * Stylesheet.
 */

var defaultStylesheet = join(__dirname, 'public', 'style.css');

/**
 * Media types and the map for content negotiation.
 */

var mediaTypes = [
  'text/html',
  'text/plain',
  'application/json'
];

var mediaType = {
  'text/html': 'html',
  'text/plain': 'plain',
  'application/json': 'json'
};

/**
 * Serve directory listings with the given `root` path.
 *
 * See Readme.md for documentation of options.
 *
 * @param {String} root
 * @param {Object} options
 * @return {Function} middleware
 * @public
 */

function serveIndex(root, options) {
  var opts = options || {};

  // root required
  if (!root) {
    throw new TypeError('serveIndex() root path required');
  }

  // resolve root to absolute and normalize
  var rootPath = normalize(resolve(root) + sep);

  var filter = opts.filter;
  var hidden = opts.hidden;
  var icons = opts.icons;
  var stylesheet = opts.stylesheet || defaultStylesheet;
  var template = opts.template || defaultTemplate;
  var templates = opts.templates || defaultTemplates;
  var view = opts.view || 'tiles';
  var sort = mkFileSort(opts.sort);
  return function _serveIndex(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 'OPTIONS' === req.method ? 200 : 405;
      res.setHeader('Allow', 'GET, HEAD, OPTIONS');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    // parse URLs
    var url = parseUrl(req);
    var originalUrl = parseUrl.original(req);

    try {
      var dir = decodeURIComponent(url.pathname);
      var originalDir = decodeURIComponent(originalUrl.pathname);
    } catch (e) {
      return next(createError(400));
    }

    // join / normalize from root dir
    var path = normalize(join(rootPath, dir));

    // null byte(s), bad request
    if (~path.indexOf('\0')) return next(createError(400));

    // malicious path
    if ((path + sep).substr(0, rootPath.length) !== rootPath) {
      debug('malicious path "%s"', path);
      return next(createError(403));
    }

    // determine ".." display
    var showUp = normalize(resolve(path) + sep) !== rootPath;

    // check if we have a directory
    debug('stat "%s"', path);
    fs.stat(path, function _stat(err, stat) {
      if (err && err.code === 'ENOENT') {
        return next();
      }

      if (err) {
        err.status = err.code === 'ENAMETOOLONG'
          ? 414
          : 500;
        return next(err);
      }

      if (!stat.isDirectory()) return next();

      // fetch files
      debug('readdir "%s"', path);
      fs.readdir(path, function _readdir(err, files) {
        if (err) return next(err);
        if (!hidden) files = removeHidden(files);
        if (filter) files = files.filter(function (filename, index, list) {
          return filter(filename, index, list, path);
        });

        // add parent directory as first
        if (showUp) {
          files.unshift('..');
        }

        // content-negotiation
        var accept = accepts(req);
        var type = accept.type(mediaTypes);

        // not acceptable
        if (!type) return next(createError(406));

        // stat all files
        fstat(path, files, function (err, stats) {
          if (err) return next(err);

          // combine the stats into the file list,
          // ignoring ENOENT / null stat objects
          var fileList = files.map(function (file, i) {
            return { name: file, stat: stats[i] };
          }).filter(function (file) { return file.stat });

          // sort file list
          fileList.sort(sort);

          // make similar to file object (with stat)
          var directory = {
            name: originalDir,
            type: 'inode/directory',
            size: stat.size,
            lastModified: stat.mtime
          }

          var nodes = fileList.map(function (file) {
            var ext = extname(file.name)
            var mimetype = mime.lookup(ext)
            return {
              name: file.name,
              type: file.stat.isDirectory() ? 'inode/directory' : mimetype,
              size: file.stat.size,
              lastModified: file.stat.mtime
            }
          })

          serveIndex[mediaType[type]](req, res, directory, nodes, next, {
            // whether '..' should be shown
            hasParent: showUp,
            // whether to show icons
            icons: icons,
            // actual fs path
            path: path,
            // tiles or details
            view: view,
            // path to template
            template: template,
            // string templates
            templates: templates,
            // path to stylesheet
            stylesheet: stylesheet,
          })
        });
      });
    });
  };
};

/**
 * Respond with text/html.
 */

serveIndex.html = function _html(req, res, directory, files, next, options) {
  var showUp = options.hasParant
  var icons = options.icons
  var path = options.path
  var view = options.view
  var template = options.template
  var stylesheet = options.stylesheet
  var render = typeof template !== 'function'
    ? createHtmlRender(template)
    : template

  // read stylesheet
  fs.readFile(stylesheet, 'utf8', function (err, style) {
    if (err) return next(err);

    // create locals for rendering
    var locals = {
      directory: directory.name,
      displayIcons: Boolean(icons),
      escape: escapeHtml,
      fileList: files,
      isHtml: true,
      path: path,
      style: style,
      templates: options.templates.html,
      viewName: view,
    };
    locals.style = locals.style.concat(iconStyle(locals.fileList, locals.displayIcons))

    // render html
    render(locals, function (err, body) {
      if (err) return next(err);
      send(res, 'text/html', body)
    });
  });
};

/**
 * Respond with application/json.
 */

serveIndex.json = function _json(req, res, directory, files, next, options) {
  send(res, 'application/json', JSON.stringify(files))
}

/**
 * Respond with text/plain.
 */

serveIndex.plain = function _plain(req, res, directory, files, next, options) {
  // create locals for rendering
  var locals = {
    directory: directory.name,
    displayIcons: Boolean(icons),
    fileList: files,
    path: options.path,
    templates: options.templates.plain,
    viewName: options.view,
  };

  send(res, 'text/plain', renderTemplate(locals.templates.page, locals))
}

/**
 * Map html `files`, returning an html unordered list.
 * @private
 */

function createFileList(files, dirname, options) {
  var escape = options.escape
  var useIcons = options.displayIcons
  var view = options.viewName
  var html = options.templates.list
    .replace(/{view}/g, view)
    .replace(/{header}/g, view === 'details' ? options.templates.header : '')

  var items = files.map(function (file) {
    var classes = [];
    var isDir = 'inode/directory' === file.type
    var path = dirname.split('/').map(function (c) { return encodeURIComponent(c); });

    if (useIcons) {
      classes.push('icon');

      if (isDir) {
        classes.push('icon-directory');
      } else {
        var ext = extname(file.name);
        var icon = iconLookup(file.name);

        classes.push('icon');
        classes.push('icon-' + ext.substring(1));

        if (classes.indexOf(icon.className) === -1) {
          classes.push(icon.className);
        }
      }
    }

    path.push(encodeURIComponent(file.name));

    var date = file.lastModified && file.name !== '..'
      ? file.lastModified.toLocaleDateString() + ' ' + file.lastModified.toLocaleTimeString()
      : '';
    // human readable
    var size = file.size && !isDir
      ? prettyBytes(file.size)
      : '';

    return options.templates.item
      .replace(/{path}/g, escape(normalizeSlashes(normalize(path.join('/')))))
      .replace(/{classes}/g, escape(classes.join(' ')))
      .replace(/{file\.name}/g, escape(file.name))
      .replace(/{file\.size}/g, escape(size))
      .replace(/{file\.lastModified}/g, escape(date))
  }).join('\n');

  return html.replace(/{items}/g, items)
}

/**
 * Create function to render html.
 */

function createHtmlRender(template) {
  return function render(locals, callback) {
    // read template
    fs.readFile(template, 'utf8', function (err, str) {
      if (err) return callback(err);

      var body = renderTemplate(str, locals)

      callback(null, body);
    });
  };
}

/**
 * Generic template renderer.
 */
function renderTemplate(str, locals) {
  var escape = locals.escape || (locals.isHtml ? escapeHtml : function (x) { return x })
  return str
    .replace(/{style}/g, locals.style)
    .replace(/{files}/g, createFileList(locals.fileList, locals.directory, {
      displayIcons: locals.displayIcons,
      escape: escape,
      templates: locals.templates,
      viewName: locals.viewName,
    }))
    .replace(/{directory}/g, escape(locals.directory))
    .replace(/{linked-path}/g, htmlPath(locals.directory))
}

/**
 * Generate the appropriate sort function, where parent directories always end up top and
 * directories always end up before files.
 */

function mkFileSort(f) {
  if (!f) {
    f = function _defaultNameSort(a, b) {
      return String(a.name).toLocaleLowerCase().localeCompare(String(b.name).toLocaleLowerCase());
    };
  }

  return function _fileSort(a, b) {
    // sort ".." to the top
    if (a.name === '..' || b.name === '..') {
      return a.name === b.name ? 0
        : a.name === '..' ? -1 : 1;
    }

    return Number(b.stat && b.stat.isDirectory()) - Number(a.stat && a.stat.isDirectory()) ||
      f(a, b);
  };
}

/**
 * Map html `dir`, returning a linked path.
 */

function htmlPath(dir) {
  var parts = dir.split('/');
  var crumb = new Array(parts.length);

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumb[i] = '<a href="' + escapeHtml(parts.slice(0, i + 1).join('/')) + '">' + escapeHtml(part) + '</a>';
    }
  }

  return crumb.join(' / ');
}

/**
 * Get the icon data for the file name.
 */

function iconLookup(filename) {
  var ext = extname(filename);

  // try by extension
  if (icons[ext]) {
    return {
      className: 'icon-' + ext.substring(1),
      fileName: icons[ext]
    };
  }

  var mimetype = mime.lookup(ext);

  // default if no mime type
  if (mimetype === false) {
    return {
      className: 'icon-default',
      fileName: icons.default
    };
  }

  // try by mime type
  if (icons[mimetype]) {
    return {
      className: 'icon-' + mimetype.replace('/', '-'),
      fileName: icons[mimetype]
    };
  }

  var suffix = mimetype.split('+')[1];

  if (suffix && icons['+' + suffix]) {
    return {
      className: 'icon-' + suffix,
      fileName: icons['+' + suffix]
    };
  }

  var type = mimetype.split('/')[0];

  // try by type only
  if (icons[type]) {
    return {
      className: 'icon-' + type,
      fileName: icons[type]
    };
  }

  return {
    className: 'icon-default',
    fileName: icons.default
  };
}

/**
 * Load icon images, return css string.
 */

function iconStyle(files, useIcons) {
  if (!useIcons) return '';
  var i;
  var list = [];
  var rules = {};
  var selector;
  var selectors = {};
  var style = '';

  for (i = 0; i < files.length; i++) {
    var file = files[i];

    var isDir = 'inode/directory' === file.type
    var icon = isDir
      ? { className: 'icon-directory', fileName: icons.folder }
      : iconLookup(file.name);
    var iconName = icon.fileName;

    selector = '#files .' + icon.className + ' .name';

    if (!rules[iconName]) {
      rules[iconName] = 'background-image: url(data:image/png;base64,' + load(iconName) + ');'
      selectors[iconName] = [];
      list.push(iconName);
    }

    if (selectors[iconName].indexOf(selector) === -1) {
      selectors[iconName].push(selector);
    }
  }

  for (i = 0; i < list.length; i++) {
    iconName = list[i];
    style += selectors[iconName].join(',\n') + ' {\n  ' + rules[iconName] + '\n}\n';
  }

  return style;
}

/**
 * Load and cache the given `icon`.
 *
 * @param {String} icon
 * @return {String}
 * @api private
 */

function load(icon) {
  if (cache[icon]) return cache[icon];
  return cache[icon] = fs.readFileSync(__dirname + '/public/icons/' + icon, 'base64');
}

/**
 * Normalizes the path separator from system separator
 * to URL separator, aka `/`.
 *
 * @param {String} path
 * @return {String}
 * @api private
 */

function normalizeSlashes(path) {
  return path.split(sep).join('/');
};

/**
 * Filter "hidden" `files`, aka files
 * beginning with a `.`.
 *
 * @param {Array} files
 * @return {Array}
 * @api private
 */

function removeHidden(files) {
  return files.filter(function (file) {
    return file[0] !== '.'
  });
}

/**
 * Send a response.
 * @private
 */

function send(res, type, body) {
  // security header for content sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // standard headers
  res.setHeader('Content-Type', type + '; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))

  // body
  res.end(body, 'utf8')
}

/**
 * Array of fs.stat errors that apply to an entry, not the operation
 */
var EntryErrors = ['EACCES', 'EBUSY', 'EEXIST', 'ENOENT', 'ENXIO', 'EPERM', 'EROFS'];

/**
 * Stat all files and return array of stat
 * in same order.
 */

function fstat(dir, files, cb) {
  var batch = new Batch();

  batch.concurrency(10);

  files.forEach(function (file) {
    batch.push(function (done) {
      fs.stat(join(dir, file), function (err, stat) {
        // communicate errors via fake stat
        if (err) {
          if (EntryErrors.indexOf(err.code) === -1) return done(err);

          stat = {
            size: 0,
            mtime: new Date(0),
            error: err.toString(),
            code: err.code,
            isDirectory: function () { return false }
          }
        }

        // pass EntryErrors as null stat, not error
        done(null, stat || null);
      });
    });
  });

  batch.end(cb);
}

/**
 * Icon map.
 */

var icons = {
  // base icons
  'default': 'page_white.png',
  'folder': 'folder.png',

  // generic mime type icons
  'font': 'font.png',
  'image': 'image.png',
  'text': 'page_white_text.png',
  'video': 'film.png',

  // generic mime suffix icons
  '+json': 'page_white_code.png',
  '+xml': 'page_white_code.png',
  '+zip': 'box.png',

  // specific mime type icons
  'application/javascript': 'page_white_code_red.png',
  'application/json': 'page_white_code.png',
  'application/msword': 'page_white_word.png',
  'application/pdf': 'page_white_acrobat.png',
  'application/postscript': 'page_white_vector.png',
  'application/rtf': 'page_white_word.png',
  'application/vnd.ms-excel': 'page_white_excel.png',
  'application/vnd.ms-powerpoint': 'page_white_powerpoint.png',
  'application/vnd.oasis.opendocument.presentation': 'page_white_powerpoint.png',
  'application/vnd.oasis.opendocument.spreadsheet': 'page_white_excel.png',
  'application/vnd.oasis.opendocument.text': 'page_white_word.png',
  'application/x-7z-compressed': 'box.png',
  'application/x-sh': 'application_xp_terminal.png',
  'application/x-msaccess': 'page_white_database.png',
  'application/x-shockwave-flash': 'page_white_flash.png',
  'application/x-sql': 'page_white_database.png',
  'application/x-tar': 'box.png',
  'application/x-xz': 'box.png',
  'application/xml': 'page_white_code.png',
  'application/zip': 'box.png',
  'image/svg+xml': 'page_white_vector.png',
  'text/css': 'page_white_code.png',
  'text/html': 'page_white_code.png',
  'text/less': 'page_white_code.png',

  // other, extension-specific icons
  '.accdb': 'page_white_database.png',
  '.apk': 'box.png',
  '.app': 'application_xp.png',
  '.as': 'page_white_actionscript.png',
  '.asp': 'page_white_code.png',
  '.aspx': 'page_white_code.png',
  '.bat': 'application_xp_terminal.png',
  '.bz2': 'box.png',
  '.c': 'page_white_c.png',
  '.cab': 'box.png',
  '.cfm': 'page_white_coldfusion.png',
  '.clj': 'page_white_code.png',
  '.cc': 'page_white_cplusplus.png',
  '.cgi': 'application_xp_terminal.png',
  '.cpp': 'page_white_cplusplus.png',
  '.cs': 'page_white_csharp.png',
  '.db': 'page_white_database.png',
  '.dbf': 'page_white_database.png',
  '.deb': 'box.png',
  '.dll': 'page_white_gear.png',
  '.dmg': 'drive.png',
  '.docx': 'page_white_word.png',
  '.erb': 'page_white_ruby.png',
  '.exe': 'application_xp.png',
  '.fnt': 'font.png',
  '.gam': 'controller.png',
  '.gz': 'box.png',
  '.h': 'page_white_h.png',
  '.ini': 'page_white_gear.png',
  '.iso': 'cd.png',
  '.jar': 'box.png',
  '.java': 'page_white_cup.png',
  '.jsp': 'page_white_cup.png',
  '.lua': 'page_white_code.png',
  '.lz': 'box.png',
  '.lzma': 'box.png',
  '.m': 'page_white_code.png',
  '.map': 'map.png',
  '.msi': 'box.png',
  '.mv4': 'film.png',
  '.pdb': 'page_white_database.png',
  '.php': 'page_white_php.png',
  '.pl': 'page_white_code.png',
  '.pkg': 'box.png',
  '.pptx': 'page_white_powerpoint.png',
  '.psd': 'page_white_picture.png',
  '.py': 'page_white_code.png',
  '.rar': 'box.png',
  '.rb': 'page_white_ruby.png',
  '.rm': 'film.png',
  '.rom': 'controller.png',
  '.rpm': 'box.png',
  '.sass': 'page_white_code.png',
  '.sav': 'controller.png',
  '.scss': 'page_white_code.png',
  '.srt': 'page_white_text.png',
  '.tbz2': 'box.png',
  '.tgz': 'box.png',
  '.tlz': 'box.png',
  '.vb': 'page_white_code.png',
  '.vbs': 'page_white_code.png',
  '.xcf': 'page_white_picture.png',
  '.xlsx': 'page_white_excel.png',
  '.yaws': 'page_white_code.png'
};
