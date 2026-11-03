// react/jsx-runtime over the page's React (window.React): the design
// canvas supplies React, so the kit bundle carries none of its own.
import React from "react";

const withKey = (props, key) => (key === undefined ? props : { ...props, key });
export const Fragment = React.Fragment;
export const jsx = (type, props, key) => React.createElement(type, withKey(props, key));
export const jsxs = jsx;
export const jsxDEV = jsx;
