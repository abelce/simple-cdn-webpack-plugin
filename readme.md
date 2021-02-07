## simple-cdn-webpack-plugin

> Upload the file to Qiniu cdn

##  Installation and usage

Install

```
npm install --save-dev simple-cdn-webpack-plugin
```

or

```
yarn add --dev simple-cdn-webpack-plugin
```

## Example

```
const SimleCdnWebpackPlugin = required("simple-cdn-webpack-plugin");

new SimleCdnWebpackPlugin({
    accessKey: 'xxx',
    secretKey: 'xxx',
    zone: 'xxx',
    bucket: 'xxx',
    cdn: 'xxx',
    exclude: [/index\.html/],
    refresh: true,
    refreshFilters: [],
  })
```

##  Parameters

| Name           | Type   | Default | Description                                                  |
| -------------- | ------ | ------- | ------------------------------------------------------------ |
| accessKey      | string |         | qiniu `accessKey`,  required                                 |
| secretKey      | string |         | qiniu `secretKey`, required                                  |
| zone           | string |         | qiniu `zone`,  required                                      |
| cdn            | string |         | qiniu cdn url， required                                     |
| bucket         | string |         | qiniu `bucket`,  required                                    |
| exclude        | array  | []      | exclude files that don't need to be uploaded, parameters can be strings, regular, functions |
| Include        | array  | []      | Include files that need to be uploaded, parameters can be strings, regular, functions |
| delete         | bool   | false   | whether to delete the last uploaded files from qiniu         |
| refresh        | bool   | true    | whether to refresh the file                                  |
| refreshFilters | array  | []      | filter files that need to be refreshed, all files are refreshed by default. parameters can be strings, regular, functions |
| prefiex | string | | the `prefix` of the filename |


## License

```
MIT License

Copyright (c) 2020 Abelce
```

