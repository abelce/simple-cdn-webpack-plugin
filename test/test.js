const SQiNiu = require('../src/upload');

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

    const s = new Upload({
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