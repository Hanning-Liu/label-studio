/* eslint-disable */
export default {
  displayName: "datamanager",
  preset: "../../jest.preset.js",
  transform: {
    "^(?!.*\\.(js|jsx|ts|tsx|css|json)$)": "@nx/react/plugins/jest",
    "^.+\\.[tj]sx?$": ["babel-jest", { presets: ["@nx/react/babel"] }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
  moduleDirectories: ["node_modules", "<rootDir>/../../node_modules"],
  coverageDirectory: "../../coverage/libs/datamanager",
  moduleNameMapper: {
    "^@hanning/(.*)$": "<rootDir>/../../../hanning/$1",
    "^@humansignal/editor/(.*)$": "<rootDir>/../editor/src/$1",
    "^react-markdown$": "<rootDir>/../editor/__mocks__/react-markdown.tsx",
    "^rehype-raw$": "<rootDir>/../editor/__mocks__/rehype-raw.ts",
    "\\.(css|less|scss|sass)$": "identity-obj-proxy",
    "\\.(gif|ttf|eot|svg|png)$": "<rootDir>/__mocks__/fileMock.js",
    "!!url-loader!": "<rootDir>/__mocks__/fileMock.js",
  },
};
