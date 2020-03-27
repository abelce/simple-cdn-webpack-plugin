const SQiNiu = require('../sQiNiu');

function run () {

    const assets = {
        "b": {
            existsAt: '/Users/tzx/work/sQiniuPlugin/test/dist/b.js',
            emitted: true,
        },
        "a": {
            existsAt: '/Users/tzx/work/sQiniuPlugin/test/dist/a.js',
            emitted: true,
        },
    };

    const s = new SQiNiu({
        accessKey: '',
        secretKey: '',
        zone: '',
        bucket: '',
        cdn: '',
        refresh: [],
    })
    function afterEmit (_, fn) {
        fn({assets});
    }
    s.apply({
        plugin: afterEmit
    });
}

run();