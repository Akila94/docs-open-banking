---
title: "Identity Server Configuration Catalog"
---
# Configuration Catalog for Identity Server

The `<IS_HOME>/repository/conf/deployment.toml` file is the single source.

## Server

<div className="mb-config-catalog">
    <section>
        <div className="mb-config-options">
            <div className="superfences-tabs">
            <input name="2" type="checkbox" id="_tab_2" />{" "}
                <label className="tab-selector" htmlFor="_tab_2"><i className="icon fa fa-code"></i></label>
                <div className="superfences-content">
                    <div className="mb-config-example">
<pre><code className="toml">{`[server]
hostname = "localhost"
base_path = "https://$ref{server.hostname}:\${carbon.management.port}"
# Regex for usernames
username_regex = "^[\\\\S]{3,30}$"
\x20   indented = \`true\` & <done>

`}</code>{"\n"}</pre>
                    </div>
                </div>
                <div className="doc-wrapper">
                    <div className="mb-config">
                        <div className="config-wrap">
                            <code>{"[server]"}</code>{" "}
                            <span className="badge-required">Required</span>
                            <p>
                                {"This includes configurations for <IAM_HOME> nodes."}
                            </p>
                        </div>
                        <div className="params-wrap">
                            <div className="param">
                                <div className="param-name">
                                  <span className="param-name-wrap"> <code>hostname</code> </span>
                                </div>
                                <div className="param-info">
                                    <span className="param-default-value">Default: <code>"localhost"</code></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
</div>
