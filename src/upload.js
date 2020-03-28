const qiniu = require("qiniu");
const fs = require("fs");
const crypto = require("crypto");
const findCacheDir = require("find-cache-dir");

const defaultOptions = {
  // 默认超时时间
  timeout: 600000,
  // bucket:
  // cdn:
  // zone:
  // accessKey:
  // secretKey:
  // 需要上传的文件
  include: [],
  // 排除的文件，可以是文件名、正则、函数
  exclude: [],
  // 需要刷新的文件，字符串，正则，函数均可
  refresh: false,
  refreshFilters: [],
  delete: false
};

//七牛单次刷新cdn、单次删除文件 最大的数目
const MAX_REFRESH = 100;
const MAX_DELETE = 1000;

/**
 * 初始化options，方便以后扩展字段
 * @param {*} data
 */
const getOptions = data => {
  const options = Object.assign({}, defaultOptions, data);
  if (!data.accessKey) {
    throw new Error(`accessKey is required`);
  }
  if (!data.secretKey) {
    throw new Error(`secretKey is required`);
  }
  if (!data.cdn) {
    throw new Error(`cdn is required`);
  }
  if (!data.zone) {
    throw new Error(`zone is required`);
  }
  if (Number.isInteger(data.timeout)) {
    options.timeout = data.timeout;
  }
  if (!Array.isArray(data.exclude)) {
    options.exclude = [];
  }
  if (!Array.isArray(data.include)) {
    options.include = [];
  }
  if (Array.isArray(data.refreshFilters)) {
    options.refreshFilters = [];
  }
  if (typeof data.delete !== "boolean") {
    options.delete = false;
  }
  if (typeof data.refresh !== "boolean") {
    options.refresh = false;
  }
  // cdn必须有https | http前缀，否则刷新文件会失败.
  if (!data.cdn.endsWith("https://") || !data.cdn.endsWith("http://")) {
    throw new Error(`cdn: "${data.cdn}" must have http or https prefix`);
  }
  // 为cdn自动加上/后缀
  if (!data.cdn.endsWith("/")) {
    options.cdn += "/";
  }

  return options;
};

const initData = options => {
  const config = new qiniu.conf.Config();
  config.zone = qiniu.zone[options.zone];
  qiniu.conf.RPC_TIMEOUT = options.timeout;

  return {
    config
  };
};

/**
 * 生成上传的token
 * @param {*} bucket
 * @param {*} key
 */
const uptoken = (mac, bucket, key) => {
  let putPolicy = new qiniu.rs.PutPolicy({
    scope: bucket + ":" + key
  });
  return putPolicy.uploadToken(mac);
};

/**
 * 获取文件hash值
 * @param {}} file
 */
const getFileHash = file => {
  return new Promise((resolve, reject) => {
    const newHashHandle = crypto.createHash("md5");
    const newRS = fs.createReadStream(file.existsAt);
    newRS.on("data", newHashHandle.update.bind(newHashHandle));
    newRS.on("end", function() {
      const newHash = newHashHandle.digest("hex");
      resolve(newHash);
    });
    newRS.on("error", function(err) {
      reject(err);
    });
  });
};

/**
 * 根据缓存信息判断文件是否需要上传.
 * @param {*} path
 * @param {*} cacheData
 */
const needUpload = (newHash, oldHash) => {
  return newHash !== oldHash;
};

// 递归创建目录
function mkdirsSync(dirname) {
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, {
      recursive: true
    });
  }
}

function loadCacheData() {
  const dir = findCacheDir({
    name: "sQiNiu",
    create: true
  });
  const cachePath = dir + "/cacheData.json";
  if (fs.existsSync(cachePath)) {
    const data = fs.readFileSync(cachePath);
    return JSON.parse(data) || {};
  }
  return {};
}

function writeCache(data) {
  const dir = findCacheDir({
    name: "sQiNiu",
    create: true
  });
  fs.writeFileSync(dir + "/cacheData.json", JSON.stringify(data));
}

/**
 * 过滤数组中的数据，如果filter为字符串、正则、函数
 * 函数必须有返回值
 * @param {*} filters
 * @param {*} data
 */
function filterArray(filters, data, flag = true) {
  if (filters.length === 0) {
    return data;
  }
  return [...data].filter(fileName => {
    const res = filters.some(ft => {
      if (typeof ft === "string") {
        return fileName === ft;
      }
      if (typeof ft === "function") {
        return ft(fileName);
      }
      if (ft instanceof RegExp) {
        return ft.test(fileName);
      }
      return false;
    });
    return flag ? res : !res;
  });
}

function chunkArray(data, chunkSize) {
  let slices = Math.floor(data.length / chunkSize);
  let chunkes = [];
  for (let i = 0; i < slices; i + chunkSize) {
    chunkes.push(data.slice(i, i + chunkSize));
  }
  chunkes.push(data.slice(slices * chunkSize));
  return chunkes || [];
}

class Upload {
  constructor(options) {
    this.options = getOptions(options);
    const { config } = initData(this.options);
    this.config = config;
    // 缓存数据
    this.cacheData = loadCacheData();
    this.failedData = {};
  }

  createMac() {
    return new qiniu.auth.digest.Mac(
      this.options.accessKey,
      this.options.secretKey
    );
  }

  apply(compiler) {
    compiler.plugin("after-emit", async (compilation, callback) => {
      const { assets } = compilation;
      const fileNames = filterArray(
        this.options.exclude,
        filterArray(
          this.options.include,
          Object.keys(assets).filter(key => assets[key].emitted)
        ),
        false
      );
      let newCacheData = {};

      // 开始上传
      const uploadFile = fileName => {
        const file = assets[fileName];
        const fileToken = uptoken(
          this.createMac(),
          this.options.bucket,
          fileName
        );
        const formUploader = new qiniu.form_up.FormUploader(this.config);
        const putExtra = new qiniu.form_up.PutExtra();

        return new Promise((resolve, reject) => {
          return formUploader.putFile(
            fileToken,
            fileName,
            file.existsAt,
            putExtra,
            function(err, respBody, respInfo) {
              if (err) {
                console.log(fileName + ": upload failed");
                console.error(err);
                reject(err);
              } else if (respInfo.statusCode == 200) {
                resolve();
              } else {
                console.log("upload failed");
                reject(respBody);
              }
            }
          );
        });
      };

      const uploadFiles = async fileNames => {
        console.log(`${fileNames.length} files need to upload`);
        return await fileNames.map(async fileName => {
          return await uploadFile(fileName).catch(err => {
            this.failedData[fileName] = true;
          });
        });
      };

      const filterShouldUpdateFileNames = async () => {
        return await new Promise(async (resolve, reject) => {
          try {
            const ret = await Promise.all(
              fileNames.map(async fileName => {
                const newHash = await getFileHash(assets[fileName]);
                return {
                  fileName,
                  hash: newHash
                };
              })
            );
            const tmp = [];
            ret.map(item => {
              newCacheData[item.fileName] = item.hash;
              if (needUpload(item.hash, this.cacheData[item.fileName])) {
                tmp.push(item.fileName);
              }
            });
            resolve(tmp);
          } catch {
            reject();
          }
        });
      };
      // 需要更新的文件
      const shouldUpdateFileNames = await filterShouldUpdateFileNames();

      /**
       * 删除不用的缓存文件
       */
      const deleteFiles = () => {
        if (!this.options.delete) {
          return Promise.resolve();
        }
        const cacheDataFileNames = Object.keys(this.cacheData);
        let needDeleteFiles = cacheDataFileNames.filter(
          fileName =>
            !newCacheData[fileName] ||
            newCacheData[fileName] !== this.cacheData[fileName]
        );
        console.log(`${needDeleteFiles.length} files need to delete`);
        // 没有缓存
        if (needDeleteFiles.length === 0) {
          return Promise.resolve();
        }

        const deleteFile = fileName =>
          qiniu.rs.deleteOp(this.options.bucket, fileName);

        // 批量删除文件
        const deleteByBatch = files => {
          const bucketManager = new qiniu.rs.BucketManager(
            this.createMac(),
            this.config
          );
          return new Promise((resolve, reject) => {
            bucketManager.batch(files, function(err, respBody, respInfo) {
              if (err) {
                reject(err);
              } else {
                // 200 is success, 298 is part success
                if (parseInt(respInfo.statusCode / 100) == 2) {
                  resolve();
                } else {
                  // @TODO: 当文件不存在应该忽略报错，让程序继续向下执行，删除其他文件
                  // if (respBody.error === `form key not found, missing 'op'`) {
                  // }
                  reject(respBody);
                }
              }
            });
          });
        };

        let chunkes = chunkArray(needDeleteFiles, MAX_REFRESH);
        return Promise.all(
          chunkes.map(chunk =>
            deleteByBatch(chunk.map(file => deleteFile(file)))
          )
        );
      };

      const refresh = () => {
        if (!this.options.refresh) {
          return Promise.resolve();
        }
        const cdnManager = new qiniu.cdn.CdnManager(this.createMac());
        let needRefreshUrls = filterArray(this.options.refreshFilters, [
          ...shouldUpdateFileNames
        ]).map(fileName => `${this.options.cdn}${fileName}`);
        console.log(`${needRefreshUrls.length} files need to refresh`);

        if (needRefreshUrls.length === 0) {
          return Promise.resolve();
        }

        const refreshByBatch = urlsToRefresh => {
          return new Promise((resolve, reject) => {
            cdnManager.refreshUrls(urlsToRefresh, function(
              err,
              respBody,
              respInfo
            ) {
              if (err) {
                reject(err);
              } else if (respInfo.statusCode == 200) {
                if (respBody.code === 200 || respBody.error === "success") {
                  resolve();
                }
                reject({
                  message: "refresh error",
                  respBody
                });
              } else {
                reject(respBody);
              }
            });
          });
        };

        let chunkes = chunkArray(needDeleteFiles, MAX_DELETE);
        return Promise.all(chunkes.map(chunk => refreshByBatch(chunk)));
      };

      const finish = () => {
        console.log("files successfully uploaded to Qiniu Cloud cdn!");
      };

      // 上传文件
      uploadFiles(shouldUpdateFileNames)
        // 删除旧文件
        .then(() => deleteFiles())
        // 刷新
        .then(() => refresh())
        // 修改缓存
        .then(() => writeCache(newCacheData))
        .then(() => finish())
        .catch(err => {
          console.error(err);
          throw new Error(err);
        });
      //
    });
  }
}

module.exports = Upload;
