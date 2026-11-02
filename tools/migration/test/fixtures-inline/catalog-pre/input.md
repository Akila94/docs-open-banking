# Configuration Catalog for Identity Server

The `<IS_HOME>/repository/conf/deployment.toml` file is the single source.

## Server

<div class="mb-config-catalog">
    <section>
        <div class="mb-config-options">
            <div class="superfences-tabs">
            <input name="2" type="checkbox" id="_tab_2">
                <label class="tab-selector" for="_tab_2"><i class="icon fa fa-code"></i></label>
                <div class="superfences-content">
                    <div class="mb-config-example">
<pre>
<code class="toml">[server]
hostname = "localhost"
base_path = "https://$ref{server.hostname}:${carbon.management.port}"
# Regex for usernames
username_regex = "^[\\S]{3,30}$"
    indented = `true` &amp; &lt;done&gt;

</code>
</pre>
                    </div>
                </div>
                <div class="doc-wrapper">
                    <div class="mb-config">
                        <div class="config-wrap">
                            <code>[server]</code>
                            <span class="badge-required">Required</span>
                            <p>
                                This includes configurations for <IAM_HOME> nodes.
                            </p>
                        </div>
                        <div class="params-wrap">
                            <div class="param">
                                <div class="param-name">
                                  <span class="param-name-wrap"> <code>hostname</code> </span>
                                </div>
                                <div class="param-info">
                                    <span class="param-default-value">Default: <code>&quot;localhost&quot;</code></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
</div>
