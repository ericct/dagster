import {ApolloClient, gql, ApolloConsumer} from '@apollo/client';
import {Button} from '@blueprintjs/core';
import merge from 'deepmerge';
import * as React from 'react';
import styled from 'styled-components/macro';
import * as yaml from 'yaml';

import {showCustomAlert} from 'src/app/CustomAlertProvider';
import {PipelineRunTag, IExecutionSession, IStorageData} from 'src/app/LocalStorage';
import {ShortcutHandler} from 'src/app/ShortcutHandler';
import {ConfigEditor} from 'src/configeditor/ConfigEditor';
import {ConfigEditorHelpContext} from 'src/configeditor/ConfigEditorHelpContext';
import {
  CONFIG_EDITOR_VALIDATION_FRAGMENT,
  responseToYamlValidationResult,
} from 'src/configeditor/ConfigEditorUtils';
import {isHelpContextEqual} from 'src/configeditor/isHelpContextEqual';
import {ConfigEditorRunConfigSchemaFragment} from 'src/configeditor/types/ConfigEditorRunConfigSchemaFragment';
import {ConfigEditorConfigPicker} from 'src/execute/ConfigEditorConfigPicker';
import {ConfigEditorHelp} from 'src/execute/ConfigEditorHelp';
import {ConfigEditorModePicker} from 'src/execute/ConfigEditorModePicker';
import {LaunchRootExecutionButton} from 'src/execute/LaunchRootExecutionButton';
import {LoadingOverlay} from 'src/execute/LoadingOverlay';
import {ModeNotFoundError} from 'src/execute/ModeNotFoundError';
import {RunPreview, RUN_PREVIEW_VALIDATION_FRAGMENT} from 'src/execute/RunPreview';
import {SessionSettingsBar} from 'src/execute/SessionSettingsBar';
import {SolidSelector} from 'src/execute/SolidSelector';
import {TagContainer, TagEditor} from 'src/execute/TagEditor';
import {scaffoldPipelineConfig} from 'src/execute/scaffoldType';
import {ExecutionSessionContainerPartitionSetsFragment} from 'src/execute/types/ExecutionSessionContainerPartitionSetsFragment';
import {ExecutionSessionContainerPipelineFragment} from 'src/execute/types/ExecutionSessionContainerPipelineFragment';
import {ExecutionSessionContainerRunConfigSchemaFragment} from 'src/execute/types/ExecutionSessionContainerRunConfigSchemaFragment';
import {
  PreviewConfigQuery,
  PreviewConfigQueryVariables,
} from 'src/execute/types/PreviewConfigQuery';
import {DagsterTag} from 'src/runs/RunTag';
import {PipelineSelector} from 'src/types/globalTypes';
import {SecondPanelToggle, SplitPanelContainer} from 'src/ui/SplitPanelContainer';
import {RepoAddress} from 'src/workspace/types';

const YAML_SYNTAX_INVALID = `The YAML you provided couldn't be parsed. Please fix the syntax errors and try again.`;
const LOADING_CONFIG_FOR_PARTITION = `Generating configuration...`;
const LOADING_CONFIG_SCHEMA = `Loading config schema...`;
const LOADING_RUN_PREVIEW = `Checking config...`;

interface IExecutionSessionContainerProps {
  data: IStorageData;
  onSaveSession: (changes: Partial<IExecutionSession>) => void;
  onCreateSession: (initial: Partial<IExecutionSession>) => void;
  pipeline: ExecutionSessionContainerPipelineFragment;
  partitionSets: ExecutionSessionContainerPartitionSetsFragment;
  runConfigSchemaOrError?: ExecutionSessionContainerRunConfigSchemaFragment;
  currentSession: IExecutionSession;
  pipelineSelector: PipelineSelector;
  repoAddress: RepoAddress;
}

interface IExecutionSessionContainerState {
  preview: PreviewConfigQuery | null;
  previewLoading: boolean;
  previewedDocument: any | null;

  configLoading: boolean;
  editorHelpContext: ConfigEditorHelpContext | null;
  showWhitespace: boolean;
  tagEditorOpen: boolean;
}

class ExecutionSessionContainer extends React.Component<
  IExecutionSessionContainerProps,
  IExecutionSessionContainerState
> {
  state: IExecutionSessionContainerState = {
    preview: null,
    previewLoading: false,
    previewedDocument: null,

    configLoading: false,
    showWhitespace: true,
    editorHelpContext: null,
    tagEditorOpen: false,
  };

  editor = React.createRef<ConfigEditor>();

  editorSplitPanelContainer = React.createRef<SplitPanelContainer>();

  mounted = false;

  previewCounter = 0;

  componentDidMount() {
    this.mounted = true;
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  onConfigChange = (config: any) => {
    this.props.onSaveSession({
      runConfigYaml: config,
    });
  };

  onSolidSelectionChange = (
    solidSelection: string[] | null,
    solidSelectionQuery: string | null,
  ) => {
    this.props.onSaveSession({
      solidSelection,
      solidSelectionQuery,
    });
  };

  onModeChange = (mode: string) => {
    this.props.onSaveSession({mode});
  };

  onRemoveExtraPaths = (paths: string[]) => {
    const {currentSession} = this.props;

    function deletePropertyPath(obj: any, path: string) {
      const parts = path.split('.');

      // Here we iterate through the parts of the path to get to
      // the second to last nested object. This is so we can call `delete` using
      // this object and the last part of the path.
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
        if (typeof obj === 'undefined') {
          return;
        }
      }

      const lastKey = parts.pop();
      if (lastKey) {
        delete obj[lastKey];
      }
    }

    let runConfigData = {};
    try {
      // Note: parsing `` returns null rather than an empty object,
      // which is preferable for representing empty config.
      runConfigData = yaml.parse(currentSession.runConfigYaml || '') || {};

      for (const path of paths) {
        deletePropertyPath(runConfigData, path);
      }

      const runConfigYaml = yaml.stringify(runConfigData);
      this.props.onSaveSession({runConfigYaml});
    } catch (err) {
      showCustomAlert({title: 'Invalid YAML', body: YAML_SYNTAX_INVALID});
      return;
    }
  };

  onScaffoldMissingConfig = () => {
    const {currentSession} = this.props;

    let config = {};
    const runConfigSchema = this.getRunConfigSchema();
    if (runConfigSchema) {
      config = scaffoldPipelineConfig(runConfigSchema);
    }

    try {
      // Note: parsing `` returns null rather than an empty object,
      // which is preferable for representing empty config.
      const runConfigData = yaml.parse(currentSession.runConfigYaml || '') || {};

      const updatedRunConfigData = merge(config, runConfigData);
      const runConfigYaml = yaml.stringify(updatedRunConfigData);
      this.props.onSaveSession({runConfigYaml});
    } catch (err) {
      showCustomAlert({title: 'Invalid YAML', body: YAML_SYNTAX_INVALID});
    }
  };

  buildExecutionVariables = () => {
    const {currentSession, pipelineSelector} = this.props;

    if (!currentSession || !currentSession.mode) {
      return;
    }
    const tags = currentSession.tags || [];
    let runConfigData = {};
    try {
      // Note: parsing `` returns null rather than an empty object,
      // which is preferable for representing empty config.
      runConfigData = yaml.parse(currentSession.runConfigYaml || '') || {};
    } catch (err) {
      showCustomAlert({title: 'Invalid YAML', body: YAML_SYNTAX_INVALID});
      return;
    }

    return {
      executionParams: {
        runConfigData,
        selector: pipelineSelector,
        mode: currentSession.mode,
        executionMetadata: {
          tags: [
            ...tags.map((tag) => ({key: tag.key, value: tag.value})),
            // pass solid selection query via tags
            // clean up https://github.com/dagster-io/dagster/issues/2495
            ...(currentSession.solidSelectionQuery
              ? [
                  {
                    key: DagsterTag.SolidSelection,
                    value: currentSession.solidSelectionQuery,
                  },
                ]
              : []),
            ...(currentSession?.base?.['presetName']
              ? [
                  {
                    key: DagsterTag.PresetName,
                    value: currentSession?.base?.['presetName'],
                  },
                ]
              : []),
          ],
        },
      },
    };
  };

  // have this return an object with prebuilt index
  // https://github.com/dagster-io/dagster/issues/1966
  getRunConfigSchema = (): ConfigEditorRunConfigSchemaFragment | undefined => {
    const obj = this.props.runConfigSchemaOrError;
    if (obj && obj.__typename === 'RunConfigSchema') {
      return obj;
    }
    return undefined;
  };

  getModeError = (): ModeNotFoundError => {
    const obj = this.props.runConfigSchemaOrError;
    if (obj && obj.__typename === 'ModeNotFoundError') {
      return obj;
    }
    return undefined;
  };

  saveTags = (tags: PipelineRunTag[]) => {
    const tagDict = {};
    const toSave: PipelineRunTag[] = [];
    tags.forEach((tag: PipelineRunTag) => {
      if (!(tag.key in tagDict)) {
        tagDict[tag.key] = tag.value;
        toSave.push(tag);
      }
    });
    this.props.onSaveSession({tags: toSave});
  };

  checkConfig = async (client: ApolloClient<any>, configJSON: Record<string, unknown>) => {
    const {currentSession, pipelineSelector} = this.props;

    // Another request to preview a newer document may be made while this request
    // is in flight, in which case completion of this async method should not set loading=false.
    this.previewCounter += 1;
    const currentPreviewCount = this.previewCounter;

    this.setState({previewLoading: true});

    const {data} = await client.query<PreviewConfigQuery, PreviewConfigQueryVariables>({
      fetchPolicy: 'no-cache',
      query: PREVIEW_CONFIG_QUERY,
      variables: {
        runConfigData: configJSON,
        pipeline: pipelineSelector,
        mode: currentSession.mode || 'default',
      },
    });

    if (this.mounted) {
      const isLatestRequest = currentPreviewCount === this.previewCounter;
      this.setState({
        preview: data,
        previewedDocument: configJSON,
        previewLoading: isLatestRequest ? false : this.state.previewLoading,
      });
    }

    return responseToYamlValidationResult(configJSON, data.isPipelineConfigValid);
  };

  openTagEditor = () => this.setState({tagEditorOpen: true});
  closeTagEditor = () => this.setState({tagEditorOpen: false});

  onConfigLoading = () => this.setState({configLoading: true});
  onConfigLoaded = () => this.setState({configLoading: false});

  render() {
    const {
      currentSession,
      onCreateSession,
      onSaveSession,
      partitionSets,
      pipeline,
      repoAddress,
    } = this.props;
    const {
      preview,
      previewLoading,
      previewedDocument,
      configLoading,
      editorHelpContext,
      showWhitespace,
      tagEditorOpen,
    } = this.state;
    const runConfigSchema = this.getRunConfigSchema();
    const modeError = this.getModeError();

    const tags = currentSession.tags || [];
    return (
      <SplitPanelContainer
        axis={'vertical'}
        identifier={'execution'}
        firstMinSize={100}
        firstInitialPercent={75}
        first={
          <>
            <LoadingOverlay isLoading={configLoading} message={LOADING_CONFIG_FOR_PARTITION} />
            <SessionSettingsBar>
              <ConfigEditorConfigPicker
                pipeline={pipeline}
                partitionSets={partitionSets.results}
                base={currentSession.base}
                solidSelection={currentSession.solidSelection}
                onLoading={this.onConfigLoading}
                onLoaded={this.onConfigLoaded}
                onCreateSession={onCreateSession}
                onSaveSession={onSaveSession}
                repoAddress={repoAddress}
              />
              <SessionSettingsSpacer />
              <SolidSelector
                serverProvidedSubsetError={
                  preview?.isPipelineConfigValid.__typename === 'InvalidSubsetError'
                    ? preview.isPipelineConfigValid
                    : undefined
                }
                pipelineName={pipeline.name}
                value={currentSession.solidSelection || null}
                query={currentSession.solidSelectionQuery || null}
                onChange={this.onSolidSelectionChange}
                repoAddress={repoAddress}
              />
              <SessionSettingsSpacer />
              <ConfigEditorModePicker
                modes={pipeline.modes}
                modeError={modeError}
                onModeChange={this.onModeChange}
                modeName={currentSession.mode}
              />
              {tags.length || tagEditorOpen ? null : (
                <ShortcutHandler
                  shortcutLabel={'⌥T'}
                  shortcutFilter={(e) => e.keyCode === 84 && e.altKey}
                  onShortcut={this.openTagEditor}
                >
                  <TagEditorLink onClick={this.openTagEditor}>+ Add tags</TagEditorLink>
                </ShortcutHandler>
              )}
              <TagEditor
                tags={tags}
                onChange={this.saveTags}
                open={tagEditorOpen}
                onRequestClose={this.closeTagEditor}
              />
              <div style={{flex: 1}} />
              <Button
                icon="paragraph"
                small={true}
                active={showWhitespace}
                style={{marginLeft: 'auto'}}
                onClick={() => this.setState({showWhitespace: !showWhitespace})}
              />
              <SessionSettingsSpacer />
              <SecondPanelToggle axis="horizontal" container={this.editorSplitPanelContainer} />
            </SessionSettingsBar>
            {tags.length ? <TagContainer tags={tags} onRequestEdit={this.openTagEditor} /> : null}
            <SplitPanelContainer
              ref={this.editorSplitPanelContainer}
              axis="horizontal"
              identifier="execution-editor"
              firstMinSize={100}
              firstInitialPercent={70}
              first={
                <ApolloConsumer>
                  {(client) => (
                    <ConfigEditor
                      ref={this.editor}
                      readOnly={false}
                      runConfigSchema={runConfigSchema}
                      configCode={currentSession.runConfigYaml}
                      onConfigChange={this.onConfigChange}
                      onHelpContextChange={(next) => {
                        if (!isHelpContextEqual(editorHelpContext, next)) {
                          this.setState({editorHelpContext: next});
                        }
                      }}
                      showWhitespace={showWhitespace}
                      checkConfig={async (configJSON) => {
                        return await this.checkConfig(client, configJSON);
                      }}
                    />
                  )}
                </ApolloConsumer>
              }
              second={
                <ConfigEditorHelp
                  context={editorHelpContext}
                  allInnerTypes={runConfigSchema?.allConfigTypes || []}
                />
              }
            />
          </>
        }
        second={
          <>
            <LoadingOverlay
              isLoading={!runConfigSchema || previewLoading}
              message={!runConfigSchema ? LOADING_CONFIG_SCHEMA : LOADING_RUN_PREVIEW}
            />
            <RunPreview
              document={previewedDocument}
              validation={preview ? preview.isPipelineConfigValid : null}
              solidSelection={currentSession.solidSelection}
              runConfigSchema={runConfigSchema}
              onHighlightPath={(path) => this.editor.current?.moveCursorToPath(path)}
              onRemoveExtraPaths={(paths) => this.onRemoveExtraPaths(paths)}
              onScaffoldMissingConfig={this.onScaffoldMissingConfig}
              actions={
                <LaunchRootExecutionButton
                  pipelineName={pipeline.name}
                  getVariables={this.buildExecutionVariables}
                  disabled={
                    preview?.isPipelineConfigValid?.__typename !== 'PipelineConfigValidationValid'
                  }
                />
              }
            />
          </>
        }
      />
    );
  }
}

// eslint-disable-next-line import/no-default-export
export default ExecutionSessionContainer;

const PREVIEW_CONFIG_QUERY = gql`
  query PreviewConfigQuery(
    $pipeline: PipelineSelector!
    $runConfigData: RunConfigData!
    $mode: String!
  ) {
    isPipelineConfigValid(pipeline: $pipeline, runConfigData: $runConfigData, mode: $mode) {
      ...ConfigEditorValidationFragment
      ...RunPreviewValidationFragment
    }
  }
  ${RUN_PREVIEW_VALIDATION_FRAGMENT}
  ${CONFIG_EDITOR_VALIDATION_FRAGMENT}
`;

const SessionSettingsSpacer = styled.div`
  width: 5px;
`;

const TagEditorLink = styled.div`
  color: #666;
  cursor: pointer;
  margin-left: 15px;
  text-decoration: underline;
  &:hover {
    color: #aaa;
  }
`;
