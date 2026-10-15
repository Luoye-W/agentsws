/**
 * WP345（决策 871）：**固定扩展 id**。
 *
 * 插件不上架商店，由工坊放在数据目录下一个固定文件夹里，用户「加载已解压」一次；之后工坊换掉文件夹里的文件、
 * 插件自己 `runtime.reload()`。Chrome 对已解压的插件默认按**路径**算 id——manifest 写上 `key`（公钥）就改成
 * 按这把公钥算：路径变了 id 也不变，配对（令牌绑的是扩展 id）、`chrome.storage`、已授的可选权限都保得住。
 *
 * 这里只有**公钥**（SubjectPublicKeyInfo 的 base64）。私钥只在打 `.crx` / 上架时才要，这两样都不做，
 * 所以没有留（README「固定 id」一节）。
 */
export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAycqOTRFzMSgwmUQ79g8yicXyhu5wNZg3sRcmGsaLV0CRr7ZxTmbMhKM8WujqLNPEQTmwxvJ967rSwWxT+9TqCnJ2MNWTd0SbfThBDAMnEVsz9TFp8lR/WrC5nxep1hT5BvvsJr9zEuHbXWkx+2YDyF+X+EHcElHtf3yg7dkx7t5hG3pPzsBUzWY/xDtXKouu7c/PUrwqzjDVScUeB4atdLi1Ald25Z9ryzwQx/Wgk7Kc9FsEYcIHfPQRRG1oLQUJpC+WUiR7r6ex6BOhR+qHAgnSqguOwal8VAvoWfEkQ09kDYkfsVVjUI/4fWS389HSCjYB5N3xia0qux+okYPsuQIDAQAB'

/** 这把公钥算出来的扩展 id（sha256 前 16 字节，每半字节换成 a–p；`test/identity.test.ts` 钉住）。 */
export const EXTENSION_ID = 'mlbfinfiigagllemohnopbhfdghagijg'
