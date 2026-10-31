/**
 * Tasks as a user or agent would phrase them, each with the tools (exposed names in
 * `createToolCatalogue()`) that are a right first pick. Shared by the offline search eval
 * (`tests/tool-search-eval.test.ts`) and the model eval (`tests/evals/tool-selection.eval.ts`).
 * Phrase tasks the way people talk, not in tool-name words, and give every detail the task
 * needs (values, names, the file or data): a model that is missing one rightly asks for it
 * instead of calling a tool, and that would count as a miss. Where a write needs an id only a
 * read can give (an effect id, a model id), the read is a right first pick too.
 */
export interface ToolSelectionCase {
	task: string;
	expect: string[];
}

export const TOOL_SELECTION_CASES: ToolSelectionCase[] = [
	// Documents and spreadsheets
	{ task: 'Replace every "colour" with "color" in the document', expect: ['doc__replace_text'] },
	{ task: 'Where does the document mention the refund policy?', expect: ['doc__find_text'] },
	{ task: 'Add a table with three columns to the document', expect: ['doc__edit_table'] },
	{ task: 'Put a small inline trend graph next to the revenue figure in the text', expect: ['doc__insert_sparkline'] },
	{ task: 'Fill cells A1 to C3 of the spreadsheet with the numbers 1 to 9, row by row', expect: ['sheet__set_range'] },
	{ task: 'Delete rows 4 to 6 from the sheet', expect: ['sheet__delete_rows'] },
	{ task: 'Merge the header cells across the top of the sheet', expect: ['sheet__merge_cells'] },
	// Canvas and components
	{ task: 'Add a new node to the canvas next to the start node', expect: ['editor__canvas_add_node'] },
	{ task: 'Draw an arrow linking two canvas nodes', expect: ['editor__canvas_connect'] },
	{ task: 'Tidy up the canvas so nodes do not overlap', expect: ['editor__canvas_layout'] },
	{ task: 'Turn the selected shapes into a reusable component', expect: ['components__create_component'] },
	{ task: 'Add a hover variant to the button component', expect: ['components__add_variant'] },
	{ task: 'Take a screenshot of the canvas to check the layout', expect: ['canvas-capture__capture_view', 'editor__view_editor'] },
	// Image editor
	{ task: 'Make the photo brighter and increase the contrast', expect: ['image-editor__set_adjustments', 'image-editor__add_adjustment_layer'] },
	{ task: 'Crop the image to a square', expect: ['image-editor__set_crop'] },
	{ task: 'Raise the magic wand tolerance of the selection I made earlier without starting over', expect: ['image-editor__edit_selection_step', 'image-editor__get_selection_recipe'] },
	{ task: 'Keep the vector mask sharp on the shoulders but soft along the hair', expect: ['image-editor__set_vector_mask_edge'] },
	{ task: 'Remove the green fringe from the edge of the cut-out subject', expect: ['image-editor__set_edge_despill', 'image-editor__set_edge_decontamination'] },
	{ task: 'Check whether the cutout mask has a halo or jagged edges', expect: ['image-editor__inspect_mask_edge'] },
	{ task: 'Select the sky by its blue colour', expect: ['image-editor__select_color_range', 'image-editor__magic_wand', 'image-editor__select_by_color', 'image-editor__select_sky'] },
	{ task: 'Hide part of a layer with a mask', expect: ['image-editor__add_layer_mask', 'image-editor__apply_selection_as_mask'] },
	{ task: 'Remove a blemish from the portrait', expect: ['image-editor__spot_heal', 'image-editor__heal_brush'] },
	{ task: 'Add a headline in bold type to the image', expect: ['image-editor__add_text_layer'] },
	{ task: 'Add a drop shadow to the logo layer', expect: ['image-editor__add_layer_effect'] },
	{ task: 'Open this Photoshop file (base64): OEJQUwABAAAAAAAAAAMAAAABAAAAAQAIAAM=', expect: ['image-editor__import_psd', 'image-editor__inspect_psd'] },
	{ task: 'Save the image as a PSD', expect: ['image-editor__export_psd'] },
	{ task: 'Convert the image to CMYK for print', expect: ['image-editor__set_color_mode', 'image-editor__convert_to_profile'] },
	{ task: 'Combine all visible layers into one', expect: ['image-editor__merge_visible', 'image-editor__flatten_image'] },
	{ task: 'Show me the tonal distribution of the photo', expect: ['image-editor__get_histogram'] },
	// Paint editor
	{ task: 'Switch to watercolour paper with heavy grain', expect: ['paint-editor__set_paper'] },
	{ task: 'Choose a soft charcoal brush', expect: ['paint-editor__set_brush', 'paint-editor__list_brushes'] },
	{ task: 'Paint a stroke across the canvas', expect: ['paint-editor__paint_stroke'] },
	{ task: 'Let the wet watercolour bleed and spread for a moment', expect: ['paint-editor__advance_wet_paint'] },
	{ task: 'Paint with mirror symmetry', expect: ['paint-editor__set_symmetry'] },
	{ task: 'Suggest complementary colours for this blue', expect: ['paint-editor__color_harmony'] },
	{ task: 'Make a video of the painting being painted', expect: ['paint-editor__export_time_lapse'] },
	{ task: 'Mix ultramarine and yellow the way real paint mixes', expect: ['paint-editor__mix_colors', 'paint-editor__mix_on_pad', 'image-editor__mix_colors'] },
	// Charts and diagrams
	{ task: 'Add a linear trendline to the sales series', expect: ['chart__add_chart_trendline'] },
	{ task: 'Change the Revenue number for Q3 in the chart to 120', expect: ['chart__set_chart_values'] },
	{ task: 'Load chart data from this CSV: Month,Sales\nJan,10\nFeb,12\nMar,15', expect: ['chart__import_chart_csv'] },
	{ task: 'Are the chart colours accessible for colour-blind readers?', expect: ['chart__check_chart_colors'] },
	{ task: 'Which kind of chart suits this data best?', expect: ['chart__recommend_chart'] },
	{ task: 'Swap the rows and columns of the chart', expect: ['chart__transpose_chart'] },
	{ task: 'Get the charts out of this PowerPoint file', expect: ['office-charts__list_file_charts'] },
	{ task: 'Add a "Payment" step to the flowchart', expect: ['diagram__add_diagram_node'] },
	{ task: 'Link the Login step to the Dashboard step in the diagram', expect: ['diagram__connect_diagram_nodes'] },
	{ task: 'Make the flowchart go top to bottom', expect: ['diagram__set_diagram_direction'] },
	{ task: 'Give me the diagram as Mermaid code', expect: ['diagram__export_diagram_mermaid'] },
	// Animation
	{ task: 'Make the logo fade in at the start of the animation', expect: ['animation__add_commands', 'animation__edit_animation'] },
	{ task: 'Make the whole animation last exactly ten seconds', expect: ['animation__fit_animation'] },
	{ task: 'Export the animation as Lottie JSON', expect: ['animation__export_lottie'] },
	{ task: 'Check the animation for problems', expect: ['animation__check_animation'] },
	// Video
	{ task: 'Put this clip on the timeline at 10 seconds', expect: ['video__add_video_clip'] },
	{ task: 'Cut the clip in two at the 5 second mark', expect: ['video__split_video_clip', 'video__split_video_at'] },
	{ task: 'Add a cross dissolve between the two clips', expect: ['video__set_video_transition'] },
	{ task: 'Remove the ums and uhs from the interview', expect: ['video__find_video_fillers'] },
	{ task: 'Find the quiet parts of the recording', expect: ['video__find_video_silences', 'video__find_video_pauses'] },
	{ task: 'Give the footage a warm cinematic colour grade', expect: ['video__apply_video_grade_preset', 'video__set_video_lut'] },
	{ task: 'Slow the clip down gradually to half speed', expect: ['video__set_video_speed_ramp'] },
	{ task: 'Hold the last frame of the clip for two seconds', expect: ['video__add_video_freeze_frame'] },
	{ task: 'Render the edit to an mp4 with ffmpeg', expect: ['video__export_video_ffmpeg'] },
	{ task: 'Remove the empty spaces between clips on the timeline', expect: ['video__close_video_gaps'] },
	{ task: 'Is the audio too loud?', expect: ['video__get_video_audio_levels', 'video__export_video_loudness_measure', 'video__get_video_scopes'] },
	{ task: 'Mark the moment the speaker starts talking', expect: ['video__add_video_marker'] },
	// Effects and generation
	{ task: 'Find a film grain effect for the video clip', expect: ['video-effects__search_effects'] },
	{ task: 'Apply the gradient effect to the canvas shape', expect: ['canvas-effects__apply_effect', 'canvas-effects__search_effects'] },
	{ task: 'Generate an image of a red fox in the snow', expect: ['generation__generate', 'generation__plan_generation', 'generation__list_models'] },
	{ task: 'How much will generating this video cost?', expect: ['generation__estimate_generation'] },
	{ task: 'Make another version of the image I generated yesterday', expect: ['generation-history__vary_generation', 'generation-history__recreate_generation'] },
	{ task: 'Draw an SVG illustration of a lighthouse from a prompt', expect: ['vector-generation__generate_vector_art'] },
	// Commands
	{ task: 'What menu actions can I run in this app?', expect: ['commands__list_commands'] }
];

/**
 * Written after search was tuned on the cases above and never tuned against: a check that
 * ranking changes generalise rather than fit the tuning set.
 */
export const HELD_OUT_CASES: ToolSelectionCase[] = [
	{ task: 'Bold the second paragraph heading in the document', expect: ['doc__format_text'] },
	{ task: 'Add two empty columns after column B in the sheet', expect: ['sheet__insert_columns'] },
	{ task: 'Rotate the photo 90 degrees clockwise', expect: ['image-editor__set_rotation', 'image-editor__rotate_layer_90'] },
	{ task: 'Duplicate the background layer of the image', expect: ['image-editor__duplicate_layer'] },
	{ task: 'Copy texture from one area of the photo to another', expect: ['image-editor__clone_stamp'] },
	{ task: 'Trace over a reference photo while painting', expect: ['paint-editor__set_tracing_image', 'paint-editor__add_reference_image'] },
	{ task: 'Save my current brush settings as a new brush', expect: ['paint-editor__save_brush'] },
	{ task: 'Rename the "Series 1" series in the bar chart to Revenue', expect: ['chart__update_chart_series'] },
	{ task: 'Apply the minimal style to the chart', expect: ['chart__apply_chart_preset', 'chart__list_chart_presets'] },
	{ task: 'Put the payment nodes of the diagram in a group', expect: ['diagram__group_diagram_nodes'] },
	{ task: 'Delete the arrow between Cart and Checkout in the diagram', expect: ['diagram__remove_diagram_edges'] },
	{ task: 'Shorten the end of the second clip by one second', expect: ['video__trim_video_clip'] },
	{ task: 'Add a music track under the video', expect: ['video__add_video_track'] },
	{ task: 'Get a list of edit decisions for the colourist', expect: ['video__export_video_edl'] },
	{ task: 'Show what the video looks like at 00:42', expect: ['video__render_video_frame', 'video__seek_video', 'video__get_video_frame'] },
	{ task: 'Export the animation for a Flair player', expect: ['animation__export_flair_motion', 'animation__export_flair_effect'] },
	{ task: 'Which image generation models can I use?', expect: ['generation__list_models'] },
	{ task: 'Undo my last change to the video', expect: ['video__undo_video'] }
];
