/**
 * @author doug-the-guy
 * @version v1.1.1
 * 
 * Boostrap Table Pipeline
 * -----------------------
 *
 * This plugin enables client side data caching for server side requests which will
 * eliminate the need to issue a new request every page change. This will allow
 * for a performance balance for a large data set between returning all data at once
 * (client side paging) and a new server side request (server side paging).
 *
 * There are two new options:
 *  - usePipeline: enables this feature
 *  - pipelineSize: the size of each cache window
 *
 * The size of the pipeline must be evenly divisible by the current page size. This is
 * assured by rounding up to the nearest evenly divisible value. For example, if
 * the pipeline size is 4990 and the current page size is 25, then pipeline size will
 * be dynamically set to 5000.
 *
 * The cache windows are computed based on the pipeline size and the total number of rows
 * returned by the server side query. For example, with pipeline size 500 and total rows
 * 1300, the cache windows will be:
 *
 *  [{'lower': 0, 'upper': 499}, {'lower': 500, 'upper': 999}, {'lower': 1000, 'upper': 1499}]
 *
 * Using the limit (i.e. the pipelineSize) and offset parameters, the server side request
 * MUST return only the data in the requested cache window AND the total number of rows.
 *
 * On a page change, the new offset is checked if it is within the current cache window. If so,
 * the requested page data is returned from the cached data set. Otherwise, a new server side
 * request will be issued for the new cache window.
 * 
 * The current cached data is only invalidated on these events:
 *  * sorting
 *  * searching
 *  * page size change
 *  * page change moves into a new cache window
 *
 * There are two new events:
 *  - cached-data-hit.bs.table: issued when cached data is used on a page change
 *  - cached-data-reset.bs.table: issued when the cached data is invalidated and a
 *      a new server side request is issued
 *
 **/

(function ($) {
    
    'use strict';

    var Utils = $.fn.bootstrapTable.utils;

    $.extend($.fn.bootstrapTable.defaults, {
        usePipeline: false,
        pipelineSize: 1000,
        onCachedDataHit: function(data) {
            return false;
        },
        onCachedDataReset: function(data){
            return false;
        }
    });

    $.extend($.fn.bootstrapTable.Constructor.EVENTS, {
        'cached-data-hit.bs.table': 'onCachedDataHit',
        'cached-data-reset.bs.table': 'onCachedDataReset'
    });

    var BootstrapTable = $.fn.bootstrapTable.Constructor,
        _init = BootstrapTable.prototype.init,
        _initServer = BootstrapTable.prototype.initServer,
        _onSearch = BootstrapTable.prototype.onSearch,
        _onSort = BootstrapTable.prototype.onSort,
        _onPageListChange = BootstrapTable.prototype.onPageListChange;

    BootstrapTable.prototype.init = function () {
        // needs to be called before initServer()  
        this.initPipeline();
        _init.apply(this, Array.prototype.slice.apply(arguments));
    };

    BootstrapTable.prototype.initPipeline = function() {
        this.cacheRequestJSON = {};
        this.cacheWindows = [];
        this.currWindow = 0;
        this.resetCache = true;
    };

    BootstrapTable.prototype.onSearch = function({currentTarget, firedByInitSearchText}) {
        /* force a cache reset on search */
        if (this.options.usePipeline) {
            this.resetCache = true;
        }
        _onSearch.apply(this, Array.prototype.slice.apply(arguments));
    };

    BootstrapTable.prototype.onSort = function({type, currentTarget}) {
        /* force a cache reset on sort */
        if (this.options.usePipeline) {
            this.resetCache = true;
        }
        _onSort.apply(this, Array.prototype.slice.apply(arguments));
    };

    BootstrapTable.prototype.onPageListChange = function (event) {
        /* rebuild cache window on page size change */
        let $this = $(event.currentTarget);
        let newPageSize = parseInt($this.text());
        this.options.pipelineSize = this.calculatePipelineSize(this.options.pipelineSize, newPageSize);
        this.resetCache = true;
        _onPageListChange.apply(this, Array.prototype.slice.apply(arguments));
    };

    BootstrapTable.prototype.calculatePipelineSize = function(pipelineSize, pageSize) {
        /* calculate pipeline size by rounding up to the nearest value evenly divisible
         * by the pageSize */
        if(pageSize == 0) return 0;
        return Math.ceil(pipelineSize/pageSize) * pageSize;
    };

    BootstrapTable.prototype.setCacheWindows = function() {
        /* set cache windows based on the total number of rows returned by server side
         * request and the pipelineSize */
        this.cacheWindows = [];
        let numWindows = this.options.totalRows / this.options.pipelineSize;
        for(let i = 0; i <= numWindows; i++){
            let b = i * this.options.pipelineSize;
            this.cacheWindows[i] = {'lower': b, 'upper': b + this.options.pipelineSize - 1};
        }
    };

    BootstrapTable.prototype.setCurrWindow = function(offset) {
        /* set the current cache window index, based on where the current offset falls */
        this.currWindow = 0;
        for(let i = 0; i < this.cacheWindows.length; i++){
            if(this.cacheWindows[i].lower <= offset && offset <= this.cacheWindows[i].upper){
                this.currWindow = i;
                break;
            }
        }
    };

    BootstrapTable.prototype.drawFromCache = function(offset, limit) {
        /* draw rows from the cache using offset and limit */
        let res = $.extend(true, {}, this.cacheRequestJSON)
        let drawStart = offset - this.cacheWindows[this.currWindow].lower;
        let drawEnd = drawStart + limit
        res.rows = res.rows.slice(drawStart, drawEnd)
        return res
    };

    BootstrapTable.prototype.initServer = function(silent, query, url){
        /* determine if requested data is in cache (on paging) or if 
         * a new ajax request needs to be issued (sorting, searching, paging
         * moving outside of cached data, page size change)
         * initial version of this extension will entirely override base initServer 
         **/

        let data = {}
        const index = this.header.fields.indexOf(this.options.sortName)

        let params = {
            searchText: this.searchText,
            sortName: this.options.sortName,
            sortOrder: this.options.sortOrder
        }

        let request

        if (this.header.sortNames[index]) {
            params.sortName = this.header.sortNames[index]
        }

        if (this.options.pagination && this.options.sidePagination === 'server') {
            params.pageSize = this.options.pageSize === this.options.formatAllRows()
                ? this.options.totalRows : this.options.pageSize
            params.pageNumber = this.options.pageNumber
        }

        if (!(url || this.options.url) && !this.options.ajax) {
            return
        }

        let useAjax = true;
        if (this.options.queryParamsType === 'limit') {
            params = {
                searchText: params.searchText,
                sortName: params.sortName,
                sortOrder: params.sortOrder
            }
            if (this.options.pagination && this.options.sidePagination === 'server') {
                params.limit = this.options.pageSize === this.options.formatAllRows() ? this.options.totalRows : this.options.pageSize;
                params.offset = (this.options.pageSize === this.options.formatAllRows() ? this.options.totalRows : this.options.pageSize) * (this.options.pageNumber - 1);
                if (this.options.usePipeline) {
                    // if cacheWindows is empty, this is the initial request
                    if(!this.cacheWindows.length){
                        useAjax = true;
                    // cache exists: determine if the page request is entirely within the current cached window
                    } else {
                        let w = this.cacheWindows[this.currWindow];
                        // since each cache window is aligned with the current page size
                        // checking if params.offset is beyond upper is sufficient
                        // need to requery for preceding or succeeding cache window
                        if(params.offset < w.lower || params.offset > w.upper){
                            useAjax = true;
                            this.setCurrWindow(params.offset);
                            // now set params.offset to the lower bound of the new cache window
                            // the server will return that whole cache window
                            params.offset = this.cacheWindows[this.currWindow].lower;
                        // within current cache window
                        } else {
                            useAjax = false;
                        }
                    }
                } else {
                    if (params.limit === 0) {
                        delete params.limit;
                    }
                }
            }
        } 

        // force an ajax call - this is on search, sort or page size change
        if (this.resetCache) {
            useAjax = true;
            this.resetCache = false;
        }

        if(this.options.usePipeline && useAjax) {
            /* in this scenario limit is used on the server to get the cache window
             * and drawLimit is used to get the page data afterwards */
            params.drawLimit = params.limit;
            params.limit = this.options.pipelineSize;
        }

        // cached results can be used
        if(!useAjax) {
            let res = this.drawFromCache(params.offset, params.limit)
            this.load(res)
            this.trigger('load-success', res)
            this.trigger('cached-data-hit', res)
            return
        }
        // cached results can't be used
        // continue base initServer code    
        if (!($.isEmptyObject(this.filterColumnsPartial))) {
            params.filter = JSON.stringify(this.filterColumnsPartial, null)
        }

        data = Utils.calculateObjectValue(this.options, this.options.queryParams, [params], data)

        $.extend(data, query || {})

        // false to stop request
        if (data === false) {
            return
        }

        if (!silent) {
            this.$tableLoading.show()
        }

        request = $.extend({}, Utils.calculateObjectValue(null, this.options.ajaxOptions), {
            type: this.options.method,
            url: url || this.options.url,
            data: this.options.contentType === 'application/json' && this.options.method === 'post'
                ? JSON.stringify(data) : data,
            cache: this.options.cache,
            contentType: this.options.contentType,
            dataType: this.options.dataType,
            success: res => {
                res = Utils.calculateObjectValue(this.options, this.options.responseHandler, [res], res)
                // cache results if using pipelining
                if(this.options.usePipeline){
                    // store entire request in cache
                    this.cacheRequestJSON = $.extend(true, {}, res);
                    // this gets set in load() also but needs to be set before
                    // setting cacheWindows
                    this.options.totalRows = res[this.options.totalField];
                    // if this is a search, less results will be returned
                    // so cache windows need to be rebuilt. Otherwise it
                    // will come out the same
                    this.setCacheWindows()
                    this.setCurrWindow(params.offset)
                     // just load data for the page
                    res = this.drawFromCache(params.offset, params.drawLimit)
                    this.trigger('cached-data-reset', res);
                }
                this.load(res)
                this.trigger('load-success', res)
                if (!silent) this.$tableLoading.hide()
            },
            error: res => {
                let data = []
                if (this.options.sidePagination === 'server') {
                    data = {}
                    data[this.options.totalField] = 0
                    data[this.options.dataField] = []
                }
                this.load(data)
                this.trigger('load-error', res.status, res)
                if (!silent) this.$tableLoading.hide()
            }
        })

        if (this.options.ajax) {
            Utils.calculateObjectValue(this, this.options.ajax, [request], null)
        } else {
            if (this._xhr && this._xhr.readyState !== 4) {
                this._xhr.abort()
            }
            this._xhr = $.ajax(request)
        }
    }

    $.fn.bootstrapTable.methods.push()



})(jQuery);