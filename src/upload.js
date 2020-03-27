const qiniu = require("qiniu");
const fs = require("fs");
const crypto = require("crypto");
const findCacheDir = require('find-cache-dir');

const defaultOptions = {
    // 默认超时时间
    timeout: 600000,
    // bucket: 
    // cdn:
    // zone:
    // accessKey:
    // secretKey:
    // 排除的文件，可以是文件名、正则、函数
    exclude: [],
    // 需要更新的文件，字符串，正则，函数均可
    refreshFilters: [],
}

//七牛单次刷新cdn、单次删除文件 最大的数目
const MAX_REFRESH = 100;
const MAX_DELETE = 1000;

/**
 * 初始化options，方便以后扩展字段
 * @param {*} data 
 */
const getOptions = (data) => {
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
    if (Array.isArray(data.refreshFilters)) {
        options.refreshFilters = [];
    }

    return options;
}

const initData = (options) => {
    const config = new qiniu.conf.Config();
    config.zone = qiniu.zone[options.zone];
    qiniu.conf.RPC_TIMEOUT = options.timeout

    const mac = new qiniu.auth.digest.Mac(
        options.accessKey,
        options.secretKey,
    );

    const bucketManager = new qiniu.rs.BucketManager(mac, config);
    const cdnManager = new qiniu.cdn.CdnManager(mac);

    return {
        config,
        mac,
        bucketManager,
        cdnManager,
    };
}

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
const getFileHash = (file) => {
    return new Promise((resolve, reject) => {
        const newHashHandle = crypto.createHash("md5");
        const newRS = fs.createReadStream(file.existsAt);
        newRS.on("data", newHashHandle.update.bind(newHashHandle));
        newRS.on("end", function () {
            const newHash = newHashHandle.digest("hex");
            resolve(newHash);
        });
        newRS.on("error", function (err) {
            reject(err);
        });
    })
}


/**
 * 根据缓存信息判断文件是否需要上传.
 * @param {*} path 
 * @param {*} cacheData 
 */
const needUpload = (newHash, oldHash) => {
    return newHash !== oldHash;
};

/**
 * 找出需要上传的文件
 * @param {*} fileNames 
 * @param {*} exclude 
 */
const getFileNames = (fileNames, exclude = []) => {
    return fileNames.filter(fileName => {
        return !exclude.find(ex => {
            if (ex instanceof Function) {
                return ex(fileName);
            }
            if (ex instanceof RegExp) {
                return ex.test(fileName);
            }
            return fileName === ex;
        })
    })
}

// 递归创建目录
function mkdirsSync(dirname) {
    if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, {
            recursive: true,
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
    fs.writeFileSync(dir + '/cacheData.json', JSON.stringify(data));
}

/**
 * 过滤数组中的数据，如果filter为字符串、正则、函数
 * 函数必须有返回值
 * @param {*} filters 
 * @param {*} data 
 */
function filterArray(filters, data) {
    if (filters.length === 0) {
        return data;
    }
    return [...data]
        .filter(fileName => {
            return filters.some(ft => {
                if (typeof ft === 'string') {
                    return fileName === ft;
                }
                if (typeof ft === 'function') {
                    return ft(fileName);
                }
                if (ft instanceof RegExp) {
                    return ft.test(fileName);
                }
                return false;
            })
        })
}


class Upload {
    constructor(options) {
        this.options = getOptions(options);
        const {
            config,
            mac,
            bucketManager,
            cdnManager,
        } = initData(this.options);
        this.config = config;
        this.mac = mac;
        this.bucketManager = bucketManager;
        this.cdnManager = cdnManager;
        // 缓存数据
        this.cacheData = loadCacheData();
        this.failedData = {};
    }

    apply(compiler) {
        compiler.plugin('after-emit', async (compilation, callback) => {
            const {
                assets
            } = compilation;
            const fileNames = filterArray(this.options.exclude, Object.keys(assets).filter(key => assets[key].emitted));
            let newCacheData = {};

            // 开始上传
            const uploadFile = (fileName) => {
                const file = assets[fileName];
                const fileToken = uptoken(this.mac, this.options.bucket, fileName);
                const formUploader = new qiniu.form_up.FormUploader(this.config);
                const putExtra = new qiniu.form_up.PutExtra();

                return new Promise((resolve, reject) => {
                    return formUploader.putFile(fileToken, fileName, file.existsAt, putExtra, function (err, respBody, respInfo) {
                        if (err) {
                            console.log(fileName + ': upload failed');
                            console.error(err);
                            reject(err);
                        } else if (respInfo.statusCode == 200) {
                            resolve();
                        } else {
                            console.log('upload failed')
                            reject(respBody);
                        }
                    });
                })
            }

            const uploadFiles = async (fileNames) => {
                console.log(`${fileNames.length} files need to update`)
                return await fileNames.map(async fileName => {
                    return await uploadFile(fileName)
                        .catch((err) => {
                            this.failedData[fileName] = true;
                        })
                });
            }



            const filterShouldUpdateFileNames = async () => {
                return await new Promise(async (resolve, reject) => {
                    try {
                        const ret = await Promise.all(fileNames.map(async fileName => {
                            const newHash = await getFileHash(assets[fileName]);
                            return {
                                fileName,
                                hash: newHash
                            };
                        }))
                        const tmp = [];
                        ret.map(item => {
                            newCacheData[item.fileName] = item.hash;
                            if (needUpload(item.hash, this.cacheData[item.fileName])) {
                                tmp.push(item.fileName);
                            }
                        })
                        resolve(tmp);
                    } catch {
                        reject();
                    }
                })
            }
            // 需要更新的文件
            const shouldUpdateFileNames = await filterShouldUpdateFileNames();

            /**
             * 删除不用的缓存文件
             */
            const deleteFiles = () => {
                const cacheDataFileNames = Object.keys(this.cacheData);
                let needDeleteFiles = cacheDataFileNames.filter(fileName => (!newCacheData[fileName] || newCacheData[fileName] !== this.cacheData[fileName]));
                console.log(`${needDeleteFiles.length} files need to delete`)
                // 没有缓存
                if (needDeleteFiles.length === 0) {
                    return Promise.resolve();
                }

                const deleteFile = (fileName) => qiniu.rs.deleteOp(this.options.bucket, fileName)

                // 批量删除文件
                const deleteByBatch = (files) => {
                    return new Promise((resolve, reject) => {
                        this.bucketManager.batch(files, function (err, respBody, respInfo) {
                            if (err) {
                                reject(err);
                            } else {
                                // 200 is success, 298 is part success
                                if (parseInt(respInfo.statusCode / 100) == 2) {
                                    resolve()
                                } else {
                                    // @TODO: 当文件不存在应该忽略报错，让程序继续向下执行，删除其他文件
                                    // if (respBody.error === `form key not found, missing 'op'`) {
                                    // }
                                    reject(respBody);
                                }
                            }
                        });
                    })
                }

                let slices = Math.floor(needDeleteFiles.length / MAX_DELETE);
                let chunkes = [];
                for (let i = 0; i < slices; i + MAX_DELETE) {
                    chunkes.push(needDeleteFiles.slice(i, i + MAX_DELETE));
                }
                chunkes.push(needDeleteFiles.slice(slices * MAX_DELETE));
                return Promise.all(chunkes.map(chunk => deleteByBatch(chunk.map(file => deleteFile(file)))));
            }

            const refresh = () => {
                let needRefreshUrls = filterArray(this.options.refreshFilters, [...shouldUpdateFileNames])
                    .map(fileName => `${this.options.cdn}${fileName}`);
                console.log(`${needRefreshUrls.length} files need to refresh`);

                if (needRefreshUrls.length === 0) {
                    return Promise.resolve();
                }

                const refreshByBatch = (urlsToRefresh) => {
                    return new Promise((resolve, reject) => {
                        this.cdnManager.refreshUrls(urlsToRefresh, function (err, respBody, respInfo) {
                            if (err) {
                                reject(err);
                            } else if (respInfo.statusCode == 200) {
                                if (respBody.code === 200 || respBody.error === 'success') {
                                    resolve();
                                }
                                reject({
                                    message: 'refresh error',
                                    respBody
                                });
                            } else {
                                reject(respBody);
                            }
                        });
                    })
                }

                let slices = Math.floor(needRefreshUrls.length / MAX_REFRESH);
                let chunkes = [];
                for (let i = 0; i < slices; i + MAX_REFRESH) {
                    chunkes.push(needRefreshUrls.s(i, i + MAX_REFRESH));
                }
                chunkes.push(needRefreshUrls.slice(slices * MAX_DELETE));
                return Promise.all(chunkes.map(chunk => refreshByBatch(chunk)));
            }

            const finish = () => {
                console.log('files successfully uploaded to Qiniu Cloud cdn!');
            }

            // 上传文件
            uploadFiles(shouldUpdateFileNames)
                // 删除旧文件
                .then(() => deleteFiles())
                // 刷新
                .then(() => refresh())
                // 修改缓存
                .then(() => writeCache(newCacheData))
                .then(() => finish())
                .catch((err) => {
                    console.error(err);
                    throw new Error(err);
                });
            // 
        })
    }
}

module.exports = Upload;